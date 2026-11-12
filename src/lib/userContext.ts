import type { AppState, Ticket, TicketCandidate } from "./ticketMachine.ts";

/** Explicit user activities, independent of inferred location or Task category. */
export type UserActivity = "NORMAL" | "OVERTIME" | "OUTSIDE" | "UNAVAILABLE";
/** Self-reported condition, not a medical assessment. */
export type UserFatigue = "NORMAL" | "TIRED" | "UNWELL";
/** Small, user-declared requirements shared by every source and detailed step. */
export type ActionCapability = "AT_HOME" | "OUTDOORS" | "EXERCISE" | "EQUIPMENT" | "FOCUS";
/** Missing constraints mean unknown/unrestricted, never an inferred prohibition. */
export interface ExecutionConstraints {
  requiredCapabilities?: ActionCapability[];
  blockedActivities?: UserActivity[];
  effort?: "LIGHT" | "NORMAL" | "HIGH";
}
/** Activity, condition and capability restrictions expire independently using full ISO instants. */
export interface UserContext {
  activity: UserActivity;
  fatigue: UserFatigue;
  activityUntil?: string;
  fatigueUntil?: string;
  blockedCapabilities: ActionCapability[];
  capabilitiesUntil?: string;
}

/** Foreground presentation event for real context-driven issuance; never dispatched for DEFERRED. */
export const contextDirectiveIssuedEvent = "directiveContextIssued";

/** UI labels and parser allowlist; keys are stable persisted activity values. */
export const userActivityLabels: Record<UserActivity, string> = {
  NORMAL: "평상시", OVERTIME: "야근 중", OUTSIDE: "외출 중", UNAVAILABLE: "일시적으로 수행 불가",
};
/** Self-reported condition labels used by the editor and audit history. */
export const userFatigueLabels: Record<UserFatigue, string> = {
  NORMAL: "보통", TIRED: "피곤함", UNWELL: "몸이 좋지 않음",
};
/** Labels for explicit capability requirements, not category-derived assumptions. */
export const actionCapabilityLabels: Record<ActionCapability, string> = {
  AT_HOME: "집에서 수행", OUTDOORS: "야외 활동", EXERCISE: "운동", EQUIPMENT: "특정 도구 사용", FOCUS: "집중 작업",
};

/** Creates a fresh unrestricted context without sharing mutable arrays. */
export function createDefaultUserContext(): UserContext {
  return { activity: "NORMAL", fatigue: "NORMAL", blockedCapabilities: [] };
}

/** Narrows JSON objects at the optional storage boundary. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accepts full instants only; clock-only input must be completed by the local datetime editor. */
function normalizeInstant(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/** Reads supported activities without trusting keys such as Object.prototype properties. */
function isActivity(value: unknown): value is UserActivity {
  return value === "NORMAL" || value === "OVERTIME" || value === "OUTSIDE" || value === "UNAVAILABLE";
}

/** Narrows one supported user-declared action requirement. */
function isCapability(value: unknown): value is ActionCapability {
  return value === "AT_HOME" || value === "OUTDOORS" || value === "EXERCISE" || value === "EQUIPMENT" || value === "FOCUS";
}

/** Restores optional context fields from older storage and imported backups. */
export function normalizeUserContext(value: unknown): UserContext {
  if (!isRecord(value)) return createDefaultUserContext();
  const activityUntil = normalizeInstant(value.activityUntil);
  const fatigueUntil = normalizeInstant(value.fatigueUntil);
  const capabilitiesUntil = normalizeInstant(value.capabilitiesUntil);
  return {
    activity: isActivity(value.activity) ? value.activity : "NORMAL",
    fatigue: value.fatigue === "TIRED" || value.fatigue === "UNWELL" ? value.fatigue : "NORMAL",
    blockedCapabilities: Array.isArray(value.blockedCapabilities) ? [...new Set(value.blockedCapabilities.filter(isCapability))].sort() : [],
    ...(activityUntil ? { activityUntil } : {}),
    ...(fatigueUntil ? { fatigueUntil } : {}),
    ...(capabilitiesUntil ? { capabilitiesUntil } : {}),
  };
}

/** Normalizes source requirements without assigning constraints to unknown categories or titles. */
export function normalizeExecutionConstraints(value: unknown): ExecutionConstraints | undefined {
  if (!isRecord(value)) return undefined;
  const requiredCapabilities = Array.isArray(value.requiredCapabilities) ? [...new Set(value.requiredCapabilities.filter(isCapability))].sort() : [];
  const blockedActivities = Array.isArray(value.blockedActivities) ? [...new Set(value.blockedActivities.filter(isActivity))].sort() : [];
  const effort = value.effort === "LIGHT" || value.effort === "NORMAL" || value.effort === "HIGH" ? value.effort : undefined;
  return requiredCapabilities.length || blockedActivities.length || effort
    ? { ...(requiredCapabilities.length ? { requiredCapabilities } : {}), ...(blockedActivities.length ? { blockedActivities } : {}), ...(effort ? { effort } : {}) } : undefined;
}

/** Applies expiration using only explicit inputs; activity expiry never clears fatigue or other restrictions. */
export function resolveEffectiveContext(value: UserContext | undefined, now: Date): UserContext {
  const context = normalizeUserContext(value);
  if (context.activityUntil && new Date(context.activityUntil) <= now) {
    context.activity = "NORMAL";
    delete context.activityUntil;
  }
  if (context.fatigueUntil && new Date(context.fatigueUntil) <= now) {
    context.fatigue = "NORMAL";
    delete context.fatigueUntil;
  }
  if (context.capabilitiesUntil && new Date(context.capabilitiesUntil) <= now) {
    context.blockedCapabilities = [];
    delete context.capabilitiesUntil;
  }
  return context;
}

/** Returns the next meaningful expiry so foreground timers do not repeatedly wake on stale timestamps. */
export function getNextContextExpiry(value: UserContext | undefined, now: Date): string | undefined {
  const context = resolveEffectiveContext(value, now);
  return [context.activityUntil, context.fatigueUntil, context.capabilitiesUntil]
    .filter((time): time is string => time !== undefined).sort()[0];
}

/** Combines parent and step requirements without allowing a step to bypass its parent restrictions. */
export function mergeExecutionConstraints(...values: Array<ExecutionConstraints | undefined>): ExecutionConstraints | undefined {
  const constraints = values.map(normalizeExecutionConstraints).filter((value): value is ExecutionConstraints => value !== undefined);
  if (!constraints.length) return undefined;
  const efforts = { LIGHT: 1, NORMAL: 2, HIGH: 3 };
  const effort = constraints.map((value) => value.effort).filter((value): value is NonNullable<ExecutionConstraints["effort"]> => value !== undefined)
    .sort((left, right) => efforts[right] - efforts[left])[0];
  return normalizeExecutionConstraints({
    requiredCapabilities: constraints.flatMap((value) => value.requiredCapabilities ?? []),
    blockedActivities: constraints.flatMap((value) => value.blockedActivities ?? []), effort,
  });
}

/** Gives one understandable hard exclusion, including System actions and high-priority fixed schedules. */
export function getContextExclusion(constraints: ExecutionConstraints | undefined, context: UserContext): string | null {
  if (context.activity === "UNAVAILABLE") return "일시적으로 수행 불가 상태여서 새 실행 지령 발행 보류";
  if (constraints?.blockedActivities?.includes(context.activity)) return `${userActivityLabels[context.activity]}에는 수행하지 않도록 설정한 행동`;
  const unavailable = constraints?.requiredCapabilities?.find((capability) => context.blockedCapabilities.includes(capability)
    || (context.activity === "OUTSIDE" && capability === "AT_HOME"));
  if (unavailable) return `${actionCapabilityLabels[unavailable]} 필요 조건을 현재 충족하지 못함`;
  if (context.fatigue === "UNWELL" && constraints?.effort === "HIGH") return "몸이 좋지 않아 높은 강도로 설정된 행동 제외";
  return null;
}

/** Returns the configured short work-block limit; movement and completion actions are handled separately. */
export function getContextDurationLimit(context: UserContext): number {
  return context.fatigue === "UNWELL" ? 10 : context.fatigue === "TIRED" ? 15 : 30;
}

/** Resolves live source requirements and issued snapshots for an existing ACTIVE, including its exact routine step. */
export function getDirectiveConstraints(state: AppState, ticket: Pick<TicketCandidate, "sourceType" | "sourceId" | "routineStepId" | "executionConstraints">): ExecutionConstraints | undefined {
  if (ticket.sourceType === "TASK") return mergeExecutionConstraints(ticket.executionConstraints, state.tasks.find((item) => item.id === ticket.sourceId)?.executionConstraints);
  if (ticket.sourceType === "SCHEDULE") return mergeExecutionConstraints(ticket.executionConstraints, state.localScheduleItems.find((item) => item.id === ticket.sourceId)?.executionConstraints);
  if (ticket.sourceType === "ROUTINE") {
    const routine = state.idealRoutines.find((item) => item.id === ticket.sourceId);
    return mergeExecutionConstraints(ticket.executionConstraints, routine?.executionConstraints, routine?.steps?.find((step) => step.id === ticket.routineStepId)?.executionConstraints);
  }
  return mergeExecutionConstraints(ticket.executionConstraints, state.settings.systemFallbacks.find((item) => `fallback:${item.id}` === ticket.sourceId)?.executionConstraints);
}

/** Explains a hard conflict without marking a valid-at-issue directive as failed or INVALID. */
export function getActiveContextConflict(state: AppState, ticket: Ticket, now: Date): string | null {
  const context = resolveEffectiveContext(state.userContext, now);
  const excluded = getContextExclusion(getDirectiveConstraints(state, ticket), context);
  if (excluded) return excluded;
  const isDuration = ticket.actionType === "DURATION" || ticket.sourceType === "TASK"
    || (ticket.actionType === undefined && /\d+분(?:간| 동안)/u.test(ticket.action));
  const expectedEnd = Math.max(new Date(ticket.createdAt).getTime() + ticket.expectedMinutes * 60_000,
    ticket.extendedUntil ? new Date(ticket.extendedUntil).getTime() : 0);
  if (isDuration && context.fatigue !== "NORMAL" && (expectedEnd - now.getTime()) / 60_000 > getContextDurationLimit(context)) {
    return `${userFatigueLabels[context.fatigue]} 상태에서 현재 남은 수행 단위가 ${getContextDurationLimit(context)}분을 초과합니다.`;
  }
  return null;
}

/** Builds a compact status label for the main screen and persisted decision snapshots. */
export function describeUserContext(context: UserContext): string {
  return [userActivityLabels[context.activity], userFatigueLabels[context.fatigue],
    ...context.blockedCapabilities.map((capability) => `${actionCapabilityLabels[capability]} 불가`)].join(" · ");
}
