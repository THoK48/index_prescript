import { getRoutineOccurrences, getRoutineWindow, getScheduleOccurrences } from "./calendar.ts";
import {
  getContextDurationLimit, getContextExclusion, getNextContextExpiry, mergeExecutionConstraints,
  resolveEffectiveContext, userFatigueLabels, type UserContext,
} from "./userContext.ts";
import { createDirectiveAction, inferRoutineActionType } from "./directiveSentence.ts";
import { getCurrentRoutineStep, type RoutineStepProgress } from "./routineProgress.ts";
import { appendObjectParticle } from "./koreanParticle.ts";
import { getFailureCooldownUntil, getInvalidDirectiveCooldownUntil, happinessEasterEggSourceId } from "./ticketMachine.ts";
import {
  getTaskRemainingMinutes,
  isScheduleOccurrenceCompleted,
  isScheduleOccurrencePrepared,
  isTaskSourceCompleted,
} from "./sourceCompletion.ts";
import type {
  IdealRoutine,
  LocalScheduleItem,
  PlannerCandidateDecision,
  PlannerDecisionDraft,
  Settings,
  Task,
  TaskDeadlineTier,
  Ticket,
  TicketCandidate,
  TicketSourceType,
} from "./ticketMachine.ts";

export interface PlannerContext {
  now: Date;
  tasks: Task[];
  localSchedule: LocalScheduleItem[];
  idealRoutines: IdealRoutine[];
  recentTickets: Ticket[];
  settings: Settings;
  userContext?: UserContext;
}

export interface PlannerPlan {
  kind: "DIRECTIVE";
  candidate: TicketCandidate;
  decision: PlannerDecisionDraft;
}

/** Deferral is a normal outcome, not an invented fallback Ticket or an execution failure. */
export interface DeferredPlannerPlan {
  kind: "DEFERRED";
  reason: string;
  resumeAt?: string;
  decision: PlannerDecisionDraft;
}

/** Every caller must explicitly handle the absence of a newly issued directive. */
export type PlannerResult = PlannerPlan | DeferredPlannerPlan;

export type DeadlineTier = TaskDeadlineTier;

interface PreparedCandidate {
  candidate: TicketCandidate;
  label: string;
  adjustmentReason?: string;
}

interface PreparedTaskCandidate extends PreparedCandidate {
  task: Task;
  deadlineTier: DeadlineTier;
  lastExecutedAt: number;
}

interface PreparedRoutineCandidate extends PreparedCandidate {
  routine: IdealRoutine;
  stepProgress?: RoutineStepProgress;
}

interface ResolutionAdjustment<TCandidate extends PreparedCandidate> {
  candidate: TCandidate | null;
  reason: string;
}

const minuteMs = 60_000;
/** Shared whole-minute time policies used independently from priority selection. */
const availableWindowLimitMinutes = 120;
const transitionBufferMinutes = 5;
const minimumWorkMinutes = 5;
const maximumWorkMinutes = 30;

/** Finds the earliest upcoming fixed schedule or fixed-routine boundary used by all time calculations. */
function getNextPlannerBoundary(
  now: Date,
  schedules: LocalScheduleItem[],
  routines: IdealRoutine[],
  tickets: Ticket[] = [],
  userContext?: UserContext,
): Date | undefined {
  const rangeEnd = new Date(now.getTime() + 24 * 60 * minuteMs);
  const nextSchedule = getScheduleOccurrences(schedules, now, rangeEnd)
    .find((occurrence) => occurrence.startAt > now
      && !isScheduleOccurrenceCompleted(occurrence.item, occurrence.startAt, tickets)
      && !getContextExclusion(occurrence.item.executionConstraints, resolveEffectiveContext(userContext, occurrence.startAt)));
  const nextRoutine = getRoutineOccurrences(routines, now, rangeEnd).find((occurrence) => {
    if (occurrence.startAt <= now || occurrence.routine.timingMode !== "FIXED") return false;
    const step = getCurrentRoutineStep(occurrence.routine, occurrence, tickets)?.step;
    return !getContextExclusion(mergeExecutionConstraints(occurrence.routine.executionConstraints, step?.executionConstraints), resolveEffectiveContext(userContext, occurrence.startAt));
  });
  return [nextSchedule?.startAt, nextRoutine?.startAt]
    .filter((value): value is Date => value !== undefined)
    .sort((left, right) => left.getTime() - right.getTime())[0];
}

/** Maps the current minute and fallback history to one of 200 stable slots for a 0.5% Easter-egg chance. */
function shouldIssueHappinessEasterEgg(now: Date, resolvedFallbackCount: number): boolean {
  const minuteBucket = Math.floor(now.getTime() / minuteMs);
  const slot = ((minuteBucket + Math.imul(resolvedFallbackCount, 97)) % 200 + 200) % 200;
  return slot === 0;
}

/** Reports whether two instants belong to the same local calendar date. */
function isSameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

/** Formats a local clock value for a human-readable Planner decision reason. */
function formatClock(value: Date): string {
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}

/** Compares IDs by code-point order so tie-breaking does not depend on device locale. */
function compareStableIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Orders selection timestamps, including never-selected negative infinity, without producing NaN. */
function compareSelectionTimes(left: number, right: number): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Returns usable minutes before the earlier fixed schedule or routine boundary, reserving five minutes. */
export function getAvailableWindow(
  now: Date,
  schedules: LocalScheduleItem[],
  routines: IdealRoutine[] = [],
  tickets: Ticket[] = [],
  userContext?: UserContext,
): number {
  const nextBoundary = getNextPlannerBoundary(now, schedules, routines, tickets, userContext);
  if (!nextBoundary) return availableWindowLimitMinutes;
  const minutesUntilBoundary = Math.floor((nextBoundary.getTime() - now.getTime()) / minuteMs);
  return Math.max(0, Math.min(minutesUntilBoundary - transitionBufferMinutes, availableWindowLimitMinutes));
}

/** Preserves the previous public helper name while delegating all calculation to getAvailableWindow. */
export function getAvailableMinutes(now: Date, schedules: LocalScheduleItem[], routines: IdealRoutine[] = [], tickets: Ticket[] = []): number {
  return getAvailableWindow(now, schedules, routines, tickets);
}

/** Converts a Task deadline into one of six explicit urgency tiers. */
export function getDeadlineTier(task: Task, now: Date): DeadlineTier {
  if (!task.dueAt) return 5;
  const deadline = new Date(task.dueAt);
  if (Number.isNaN(deadline.getTime())) return 5;
  const hoursUntilDeadline = (deadline.getTime() - now.getTime()) / (60 * minuteMs);
  if (hoursUntilDeadline <= 0) return 0;
  if (hoursUntilDeadline <= 6) return 1;
  if (hoursUntilDeadline <= 24) return 2;
  if (hoursUntilDeadline <= 72) return 3;
  if (hoursUntilDeadline <= 168) return 4;
  return 5;
}

/** Describes one deadline tier without exposing internal numeric values. */
function getDeadlineTierLabel(task: Task, tier: DeadlineTier): string {
  if (tier === 0) return "마감 경과";
  if (tier === 1) return "6시간 이내 마감";
  if (tier === 2) return "24시간 이내 마감";
  if (tier === 3) return "3일 이내 마감";
  if (tier === 4) return "1주 이내 마감";
  return task.dueAt ? "1주 이후 마감" : "마감 없음";
}

/** Finds today's routine window, including a window that crossed midnight from yesterday. */
function resolveRoutineWindow(routine: IdealRoutine, now: Date): { startAt: Date; endAt: Date } | null {
  const today = getRoutineWindow(routine, now);
  if (today && today.startAt <= now && now < today.endAt) return today;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const previous = getRoutineWindow(routine, yesterday);
  return previous && previous.startAt <= now && now < previous.endAt ? previous : null;
}

/** Derives the latest selection time from issue history; never-selected Tasks sort first. */
function getTaskLastExecutedAt(taskId: string, tickets: Ticket[]): number {
  let latest = Number.NEGATIVE_INFINITY;
  for (const ticket of tickets) {
    if (ticket.sourceType !== "TASK" || ticket.sourceId !== taskId ||
        ticket.status === "CANCELLED") continue;
    const selectedAt = new Date(ticket.createdAt).getTime();
    if (!Number.isNaN(selectedAt)) latest = Math.max(latest, selectedAt);
  }
  return latest;
}

/** Prevents one routine occurrence from being issued again after it was resolved. */
function wasRoutineResolvedInWindow(
  routineId: string,
  window: { startAt: Date; endAt: Date },
  tickets: Ticket[],
): boolean {
  return tickets.some((ticket) => {
    if (ticket.sourceType !== "ROUTINE" || ticket.sourceId !== routineId ||
        (ticket.status !== "COMPLETED" && ticket.status !== "FAILED")) return false;
    const issuedAt = new Date(ticket.createdAt);
    return window.startAt <= issuedAt && issuedAt < window.endAt;
  });
}

/** Maps the previous environment-reset source to its equivalent current System source. */
function canonicalSourceId(sourceType: TicketSourceType, sourceId: string | undefined): string | undefined {
  return sourceType === "SYSTEM" && sourceId === "reset-environment" ? "fallback:tidy" : sourceId;
}

/** Orders terminal resolutions by their own event time without treating quality feedback as a failure. */
function compareTicketResolutions(left: Ticket, right: Ticket): number {
  const leftAt = new Date(left.invalidatedAt ?? left.completedAt ?? left.createdAt).getTime();
  const rightAt = new Date(right.invalidatedAt ?? right.completedAt ?? right.createdAt).getTime();
  return rightAt - leftAt || right.sequence - left.sequence || compareStableIds(left.id, right.id);
}

/** Finds the latest meaningful resolution, optionally scoped to one original source identity. */
function getLatestResolution(
  tickets: Ticket[],
  source?: Pick<TicketCandidate, "sourceType" | "sourceId" | "routineStepId">,
): Ticket | undefined {
  return tickets.filter((ticket) => (
    (ticket.status === "COMPLETED" || ticket.status === "FAILED" || ticket.status === "INVALID")
    && (!source || (ticket.sourceType === source.sourceType
      && canonicalSourceId(ticket.sourceType, ticket.sourceId) === canonicalSourceId(source.sourceType, source.sourceId)
      && (source.sourceType !== "ROUTINE" || ticket.routineStepId === source.routineStepId)))
  )).sort(compareTicketResolutions)[0];
}

/** Blocks registered sources during feedback cooldown and the immediately rejected System source. */
function getInvalidSourceBlock(
  source: Pick<TicketCandidate, "sourceType" | "sourceId" | "routineStepId">,
  tickets: Ticket[],
  now: Date,
): string | null {
  const resolution = getLatestResolution(tickets, source);
  if (resolution?.status !== "INVALID") return null;
  if (source.sourceType === "SYSTEM") {
    return getLatestResolution(tickets)?.id === resolution.id ? "방금 이상 지령으로 기록한 동일 행동은 즉시 재발행하지 않음" : null;
  }
  const reportedAt = new Date(resolution.invalidatedAt ?? resolution.createdAt);
  const savedUntil = resolution.cooldownUntil ? new Date(resolution.cooldownUntil) : null;
  const until = savedUntil && Number.isFinite(savedUntil.getTime())
    ? savedUntil
    : getInvalidDirectiveCooldownUntil(source.sourceType, reportedAt);
  return until && until > now ? `${formatClock(until)}까지 이상 지령 피드백에 따라 재발행 보류` : null;
}

/** Applies quality suppression separately from execution-failure duration adjustments. */
function applyRecentResolution<TCandidate extends PreparedCandidate>(
  candidate: TCandidate,
  tickets: Ticket[],
  now: Date,
  userContext?: UserContext,
): ResolutionAdjustment<TCandidate> {
  const effectiveContext = resolveEffectiveContext(userContext, now);
  const contextBlock = getContextExclusion(candidate.candidate.executionConstraints, effectiveContext);
  if (contextBlock) return { candidate: null, reason: `사용자 상태 · ${contextBlock}` };
  if (candidate.candidate.actionType === "DURATION") {
    const originalMinutes = candidate.candidate.expectedMinutes;
    const adjustedMinutes = Math.min(originalMinutes, getContextDurationLimit(effectiveContext));
    if (adjustedMinutes < originalMinutes) {
      const adjustmentReason = `${userFatigueLabels[effectiveContext.fatigue]} · 수행 단위 ${originalMinutes}→${adjustedMinutes}분`;
      candidate = { ...candidate, adjustmentReason, candidate: { ...candidate.candidate,
        expectedMinutes: adjustedMinutes, originalExpectedMinutes: originalMinutes,
        action: candidate.candidate.action.replace(/\d+분(?:간| 동안)/u, `${adjustedMinutes}분 동안`),
        selectionReason: `${candidate.candidate.selectionReason ?? "실행 가능"} · ${adjustmentReason}`,
      } };
    }
  }
  const invalidBlock = getInvalidSourceBlock(candidate.candidate, tickets, now);
  if (invalidBlock) return { candidate: null, reason: invalidBlock };
  // 품질 피드백은 별도 보류에만 사용하고 기존 수행 실패의 조정 이력을 대신하지 않습니다.
  const lastResolution = getLatestResolution(tickets.filter((ticket) => ticket.status !== "INVALID"), candidate.candidate);
  if (!lastResolution || lastResolution.status !== "FAILED") {
    return { candidate, reason: candidate.candidate.selectionReason ?? "실행 가능" };
  }

  const failedAt = new Date(lastResolution.completedAt ?? lastResolution.createdAt);
  const savedCooldownUntil = lastResolution.cooldownUntil ? new Date(lastResolution.cooldownUntil) : null;
  const cooldownUntil = savedCooldownUntil && !Number.isNaN(savedCooldownUntil.getTime())
    ? savedCooldownUntil
    : getFailureCooldownUntil(lastResolution.failureReason ?? "other", failedAt);
  if (cooldownUntil && cooldownUntil > now) {
    return { candidate: null, reason: `${formatClock(cooldownUntil)}까지 실패 후 재발행 보류` };
  }
  if (!isSameLocalDay(failedAt, now)) {
    return { candidate, reason: candidate.candidate.selectionReason ?? "실행 가능" };
  }

  if (lastResolution.failureReason === "time_shortage" || lastResolution.failureReason === "too_difficult") {
    const expectedMinutes = Math.min(
      candidate.candidate.expectedMinutes,
      Math.max(minimumWorkMinutes, Math.floor(lastResolution.expectedMinutes / 2)),
    );
    const selectionReason = `${candidate.candidate.selectionReason ?? "실행 가능"} · 최근 실패 후 ${expectedMinutes}분으로 축소`;
    return {
      candidate: {
        ...candidate,
        adjustmentReason: [candidate.adjustmentReason, `최근 실패 후 ${expectedMinutes}분으로 축소`].filter(Boolean).join(" · "),
        candidate: {
          ...candidate.candidate,
          action: candidate.candidate.action.replace(/\d+분(?:간| 동안)/, `${expectedMinutes}분 동안`),
          expectedMinutes,
          selectionReason,
        },
      },
      reason: selectionReason,
    };
  }
  return { candidate, reason: candidate.candidate.selectionReason ?? "실행 가능" };
}

/** Requires five free minutes while allowing a one-through-four-minute final Task block. */
function createTaskCandidate(
  task: Task,
  availableMinutes: number,
  now: Date,
  tickets: Ticket[],
): PreparedTaskCandidate | null {
  if (isTaskSourceCompleted(task, tickets)) return null;
  const remainingMinutes = getTaskRemainingMinutes(task, tickets);
  const expectedMinutes = Math.min(remainingMinutes, maximumWorkMinutes, availableMinutes);
  if (availableMinutes < minimumWorkMinutes || expectedMinutes < 1) return null;
  const deadlineTier = getDeadlineTier(task, now);
  return {
    task,
    deadlineTier,
    lastExecutedAt: getTaskLastExecutedAt(task.id, tickets),
    label: task.title,
    candidate: {
      action: `${expectedMinutes}분 동안 ${appendObjectParticle(task.title)} 진행할 것.`,
      expectedMinutes,
      sourceType: "TASK",
      sourceId: task.id,
      executionConstraints: task.executionConstraints,
      actionType: "DURATION",
      selectionReason: `${deadlineTier <= 3 ? "긴급 할 일" : "일반 할 일"} · ${getDeadlineTierLabel(task, deadlineTier)} · 중요도 ${task.importance} · 가용 ${availableMinutes}분`,
      deadline: task.dueAt,
      trigger: "지금,",
    },
  };
}

/** Sorts Tasks by deadline tier, importance, oldest execution, and stable ID. */
function compareTaskCandidates(left: PreparedTaskCandidate, right: PreparedTaskCandidate): number {
  return left.deadlineTier - right.deadlineTier
    || right.task.importance - left.task.importance
    || compareSelectionTimes(left.lastExecutedAt, right.lastExecutedAt)
    || compareStableIds(left.task.id, right.task.id);
}

/** Builds a selected Task explanation from the documented within-tier ordering. */
function createSelectedTaskReason(candidate: PreparedTaskCandidate, sameLayer: PreparedTaskCandidate[]): string {
  const sameDeadline = sameLayer.filter((other) => other.deadlineTier === candidate.deadlineTier);
  const sameImportance = sameDeadline.filter((other) => other.task.importance === candidate.task.importance);
  const sameExecutionTime = sameImportance.filter((other) => other.lastExecutedAt === candidate.lastExecutedAt);
  const deadlineLabel = getDeadlineTierLabel(candidate.task, candidate.deadlineTier);
  let reason: string;
  if (sameLayer.length === 1) {
    reason = `${deadlineLabel} · 실행 가능한 ${candidate.deadlineTier <= 3 ? "긴급" : "일반"} 할 일이 하나라 선택됨`;
  } else if (sameDeadline.length === 1) {
    reason = `${deadlineLabel} · 마감 구간이 가장 가까워 선택됨`;
  } else if (sameImportance.length === 1) {
    reason = `${deadlineLabel} 할 일 중 중요도(${candidate.task.importance})가 가장 높아 선택됨`;
  } else if (sameExecutionTime.length === 1) {
    reason = `${deadlineLabel} · 중요도가 같은 할 일 중 가장 오래 선택되지 않아 선택됨`;
  } else {
    reason = `${deadlineLabel} · 중요도와 마지막 선택 시각이 같아 ID 순으로 선택됨`;
  }
  return candidate.adjustmentReason ? `${reason} · ${candidate.adjustmentReason}` : reason;
}

/** Converts an evaluated candidate into a compact persisted Planner audit item. */
function createCandidateDecision(
  sourceType: TicketSourceType,
  label: string,
  disposition: PlannerCandidateDecision["disposition"],
  reason: string,
  sourceId?: string,
  details: Pick<PlannerCandidateDecision, "priorityLayer" | "deadlineTier" | "importance" | "lastExecutedAt"> = {},
): PlannerCandidateDecision {
  return { sourceType, sourceId, label, score: null, disposition, reason, ...details };
}

/** Saves the exact Task sorting inputs alongside the candidate explanation without persisting duplicate Task state. */
function createTaskDecision(
  task: Task,
  disposition: PlannerCandidateDecision["disposition"],
  reason: string,
  now: Date,
  tickets: Ticket[],
): PlannerCandidateDecision {
  const deadlineTier = getDeadlineTier(task, now);
  const lastExecutedAt = getTaskLastExecutedAt(task.id, tickets);
  return createCandidateDecision("TASK", task.title, disposition, reason, task.id, {
    priorityLayer: deadlineTier <= 3 ? 3 : 5,
    deadlineTier,
    importance: task.importance,
    lastExecutedAt: Number.isFinite(lastExecutedAt) ? new Date(lastExecutedAt).toISOString() : null,
  });
}

/** Finalizes one deterministic Planner result while retaining useful candidate diagnostics. */
function createPlannerPlan(
  context: PlannerContext,
  candidate: TicketCandidate,
  availableMinutes: number,
  decisions: PlannerCandidateDecision[],
): PlannerPlan {
  const dispositionOrder = { SELECTED: 0, ELIGIBLE: 1, EXCLUDED: 2, SKIPPED: 3 } as const;
  const candidates = [...decisions]
    .sort((left, right) => dispositionOrder[left.disposition] - dispositionOrder[right.disposition]
      || (left.priorityLayer ?? 6) - (right.priorityLayer ?? 6)
      || (left.deadlineTier ?? 5) - (right.deadlineTier ?? 5)
      || (right.importance ?? 0) - (left.importance ?? 0)
      || compareSelectionTimes(
        left.lastExecutedAt ? new Date(left.lastExecutedAt).getTime() : Number.NEGATIVE_INFINITY,
        right.lastExecutedAt ? new Date(right.lastExecutedAt).getTime() : Number.NEGATIVE_INFINITY,
      )
      || compareStableIds(left.sourceId ?? left.label, right.sourceId ?? right.label))
    .slice(0, 20);
  return {
    kind: "DIRECTIVE",
    candidate,
    decision: {
      evaluatedAt: context.now.toISOString(),
      availableMinutes,
      selectedAction: candidate.action,
      selectedReason: candidate.selectionReason ?? "Planner 계층 우선순위",
      candidates,
      userContext: resolveEffectiveContext(context.userContext, context.now),
      result: "DIRECTIVE",
    },
  };
}

/** Records why execution was deferred without issuing an artificial System action. */
function createDeferredPlan(context: PlannerContext, availableMinutes: number, decisions: PlannerCandidateDecision[], reason: string): DeferredPlannerPlan {
  const userContext = resolveEffectiveContext(context.userContext, context.now);
  return { kind: "DEFERRED", reason, resumeAt: getNextContextExpiry(userContext, context.now), decision: {
    evaluatedAt: context.now.toISOString(), availableMinutes, selectedAction: "지령 발행 보류", selectedReason: reason,
    userContext, result: "DEFERRED", candidates: decisions.slice(0, 50),
  } };
}

/** Marks remaining sources as intentionally skipped after a fixed schedule wins immediately. */
function appendPrioritySkippedDecisions(
  decisions: PlannerCandidateDecision[],
  tasks: Task[],
  routines: IdealRoutine[],
  reason: string,
  context: PlannerContext,
): void {
  for (const task of tasks) {
    const completed = isTaskSourceCompleted(task, context.recentTickets);
    const blocked = getContextExclusion(task.executionConstraints, resolveEffectiveContext(context.userContext, context.now));
    decisions.push(createTaskDecision(task, completed || blocked ? "EXCLUDED" : "SKIPPED",
      completed ? "이미 완료된 Task 원본 또는 완료 이력" : blocked ? `사용자 상태 · ${blocked}` : reason, context.now, context.recentTickets));
  }
  for (const routine of routines) {
    const window = resolveRoutineWindow(routine, context.now);
    const step = window ? getCurrentRoutineStep(routine, window, context.recentTickets)?.step : undefined;
    const blocked = getContextExclusion(mergeExecutionConstraints(routine.executionConstraints, step?.executionConstraints), resolveEffectiveContext(context.userContext, context.now));
    decisions.push(createCandidateDecision("ROUTINE", routine.title, blocked ? "EXCLUDED" : "SKIPPED", blocked ? `사용자 상태 · ${blocked}` : reason, routine.id, { priorityLayer: 4 }));
  }
}

/** Marks one candidate selected and optionally skips eligible candidates in lower tiers. */
function finalizeTierDecisions(
  decisions: PlannerCandidateDecision[],
  selected: TicketCandidate,
  reason: string,
  skippedSourceTypes: TicketSourceType[],
): void {
  for (const decision of decisions) {
    const isSelected = decision.disposition === "ELIGIBLE"
      && decision.sourceType === selected.sourceType
      && decision.sourceId === selected.sourceId;
    if (isSelected) {
      decision.disposition = "SELECTED";
      decision.reason = reason;
    } else if (decision.disposition === "ELIGIBLE" && skippedSourceTypes.includes(decision.sourceType)) {
      decision.disposition = "SKIPPED";
      decision.reason = `${reason} · 상위 계층 우선`;
    }
  }
}

/** Selects a fitting configured fallback deterministically, using passive waiting when time is too short. */
function selectSystemFallback(
  tickets: Ticket[],
  availableMinutes: number,
  now: Date,
  nextBoundaryAt: Date | undefined,
  decisions: PlannerCandidateDecision[],
  settings: Settings,
  userContext: UserContext,
): TicketCandidate | null {
  const configuredFallbacks: TicketCandidate[] = settings.systemFallbacks.map((fallback) => ({
    action: fallback.action, expectedMinutes: fallback.expectedMinutes, sourceType: "SYSTEM", sourceId: `fallback:${fallback.id}`,
    executionConstraints: fallback.executionConstraints,
    actionType: /\d+분(?:간| 동안)/u.test(fallback.action) ? "DURATION" : "COMPLETION",
  }));
  const allowedFallbacks = configuredFallbacks.filter((candidate) => {
    const reason = getContextExclusion(candidate.executionConstraints, userContext);
    if (!reason) return true;
    decisions.push(createCandidateDecision("SYSTEM", candidate.action, "EXCLUDED", `사용자 상태 · ${reason}`, candidate.sourceId, { priorityLayer: 6 }));
    return false;
  });
  if (configuredFallbacks.length > 0 && allowedFallbacks.length === 0) return null;
  if (availableMinutes < minimumWorkMinutes) {
    const waitingMinutes = nextBoundaryAt
      ? Math.max(1, Math.ceil((nextBoundaryAt.getTime() - now.getTime()) / minuteMs))
      : Math.max(1, availableMinutes);
    const waiting: TicketCandidate = {
      action: "다음 일정에 대비해 잠시 대기할 것.",
      expectedMinutes: waitingMinutes,
      sourceType: "SYSTEM",
      sourceId: "system:wait-for-schedule",
      selectionReason: nextBoundaryAt
        ? `${formatClock(nextBoundaryAt)} 다음 일정까지 ${waitingMinutes}분 남아 대기`
        : "다음 일정 전 실행할 시간이 5분 미만이라 대기",
      deadline: nextBoundaryAt?.toISOString(),
      trigger: "다음 일정이 가까우므로,",
    };
    const block = getInvalidSourceBlock(waiting, tickets, now);
    if (!block) return waiting;
    decisions.push(createCandidateDecision("SYSTEM", waiting.action, "EXCLUDED", block, waiting.sourceId, { priorityLayer: 6 }));
    return {
      action: "잠시 호흡을 고르며 대기할 것.",
      expectedMinutes: waitingMinutes,
      sourceType: "SYSTEM",
      sourceId: "system:regain-composure",
      selectionReason: "직전 대기 지령이 부적절하다고 기록되어 다른 대기 행동 선택",
      deadline: nextBoundaryAt?.toISOString(),
      trigger: "다음 일정이 가까우므로,",
    };
  }
  const resolvedFallbackCount = tickets.filter((ticket) => (
    ticket.sourceType === "SYSTEM"
    && (ticket.sourceId === "reset-environment" || ticket.sourceId?.startsWith("fallback:"))
    && (ticket.status === "COMPLETED" || ticket.status === "FAILED" || ticket.status === "INVALID")
  )).length;
  if (shouldIssueHappinessEasterEgg(now, resolvedFallbackCount)) {
    return {
      action: "행복할 것. 기간은 무제한",
      expectedMinutes: 240,
      sourceType: "SYSTEM",
      sourceId: happinessEasterEggSourceId,
      selectionReason: "System fallback 0.5% 이스터 에그",
      trigger: "",
    };
  }
  const fittingFallbacks = allowedFallbacks.filter((fallback) => fallback.expectedMinutes <= availableMinutes);
  if (fittingFallbacks.length === 0) {
    return {
      action: "가용 시간 안에서 잠시 호흡을 고를 것.",
      expectedMinutes: Math.max(1, availableMinutes),
      sourceType: "SYSTEM",
      sourceId: "system:no-fitting-fallback",
      selectionReason: "설정한 System fallback의 예상 시간이 현재 가용시간보다 길어 짧은 대기 선택",
      trigger: "지금 처리할 등록 항목이 없으므로,",
    };
  }
  let selected: TicketCandidate | undefined;
  for (let offset = 0; offset < fittingFallbacks.length; offset += 1) {
    const candidate = fittingFallbacks[(resolvedFallbackCount + offset) % fittingFallbacks.length];
    const block = getInvalidSourceBlock(candidate, tickets, now);
    if (!block) { selected = candidate; break; }
    decisions.push(createCandidateDecision("SYSTEM", candidate.action, "EXCLUDED", block, candidate.sourceId, { priorityLayer: 6 }));
  }
  if (!selected) {
    return {
      action: "잠시 호흡을 고르며 다음 행동을 준비할 것.",
      expectedMinutes: 3,
      sourceType: "SYSTEM",
      sourceId: "system:configured-fallbacks-blocked",
      selectionReason: "설정한 fallback이 모두 직전 이상 지령 피드백으로 보류되어 임시 행동 선택",
      trigger: "지금 처리할 등록 항목이 없으므로,",
    };
  }
  return {
    ...selected,
    selectionReason: "현재 실행 가능한 등록 항목 없음",
    trigger: "지금 처리할 등록 항목이 없으므로,",
  };
}

/** Chooses one action through explicit priority tiers and returns its deterministic audit trail. */
export function planNextTicketWithDecision(context: PlannerContext): PlannerResult {
  const { now, localSchedule, idealRoutines, recentTickets, tasks } = context;
  const decisions: PlannerCandidateDecision[] = [];
  const effectiveContext = resolveEffectiveContext(context.userContext, now);
  const availableMinutes = getAvailableWindow(now, localSchedule, idealRoutines, recentTickets, context.userContext);
  const nextBoundaryAt = getNextPlannerBoundary(now, localSchedule, idealRoutines, recentTickets, context.userContext);
  if (effectiveContext.activity === "UNAVAILABLE") {
    const reason = "일시적으로 수행 불가 상태여서 새 실행 지령 발행을 보류합니다.";
    for (const task of tasks) decisions.push(createTaskDecision(task, "EXCLUDED", reason, now, recentTickets));
    for (const item of localSchedule) decisions.push(createCandidateDecision("SCHEDULE", item.title, "EXCLUDED", reason, item.id));
    for (const routine of idealRoutines) decisions.push(createCandidateDecision("ROUTINE", routine.title, "EXCLUDED", reason, routine.id));
    for (const fallback of context.settings.systemFallbacks) decisions.push(createCandidateDecision("SYSTEM", fallback.action, "EXCLUDED", reason, `fallback:${fallback.id}`));
    return createDeferredPlan(context, availableMinutes, decisions, reason);
  }
  const dayBefore = new Date(now.getTime() - 24 * 60 * minuteMs);
  const dayAfter = new Date(now.getTime() + 24 * 60 * minuteMs);
  const occurrences = getScheduleOccurrences(localSchedule, dayBefore, dayAfter).filter((occurrence) => {
    const block = getContextExclusion(occurrence.item.executionConstraints, effectiveContext);
    if (block) {
      decisions.push(createCandidateDecision("SCHEDULE", occurrence.item.title, "EXCLUDED", `사용자 상태 · ${block}`, occurrence.item.id));
      return false;
    }
    if (!isScheduleOccurrenceCompleted(occurrence.item, occurrence.startAt, recentTickets)) return true;
    decisions.push(createCandidateDecision("SCHEDULE", occurrence.item.title, "EXCLUDED",
      "원본 일정의 해당 수행 회차가 이미 완료됨", occurrence.item.id, {
        priorityLayer: occurrence.startAt <= now ? 1 : 2,
      }));
    return false;
  });

  const activeSchedule = occurrences.find((occurrence) => occurrence.startAt <= now && now < occurrence.endAt);
  if (activeSchedule) {
    const remaining = Math.max(1, Math.min(30, Math.ceil((activeSchedule.endAt.getTime() - now.getTime()) / minuteMs)));
    const prepared: PreparedCandidate = {
      label: activeSchedule.item.title,
      candidate: {
        action: activeSchedule.item.type === "commute"
          ? createDirectiveAction(activeSchedule.item.title, "MOVEMENT", remaining)
          : `${activeSchedule.item.title} 일정에 집중할 것.`,
        expectedMinutes: remaining,
        sourceType: "SCHEDULE",
        sourceId: activeSchedule.item.id,
        scheduleOccurrenceStartAt: activeSchedule.startAt.toISOString(),
        schedulePhase: "EXECUTION",
        executionConstraints: activeSchedule.item.executionConstraints,
        actionType: activeSchedule.item.type === "commute" ? "MOVEMENT" : "COMPLETION",
        selectionReason: "현재 진행 중인 고정 일정이 있어 선택됨",
        deadline: activeSchedule.endAt.toISOString(),
        trigger: "현재 일정이 진행 중이므로,",
      },
    };
    const adjusted = applyRecentResolution(prepared, recentTickets, now, context.userContext);
    if (adjusted.candidate) {
      decisions.push(createCandidateDecision("SCHEDULE", prepared.label, "SELECTED", adjusted.reason, prepared.candidate.sourceId, { priorityLayer: 1 }));
      appendPrioritySkippedDecisions(decisions, tasks, idealRoutines, "현재 진행 중인 고정 일정이 우선됨", context);
      return createPlannerPlan(context, adjusted.candidate.candidate, availableMinutes, decisions);
    }
    decisions.push(createCandidateDecision("SCHEDULE", prepared.label, "EXCLUDED", adjusted.reason, prepared.candidate.sourceId, { priorityLayer: 1 }));
  }

  const nextSchedule = occurrences.find((occurrence) => {
    if (occurrence.startAt <= now) return false;
    if (!isScheduleOccurrencePrepared(occurrence.item, occurrence.startAt, recentTickets)) return true;
    decisions.push(createCandidateDecision("SCHEDULE", occurrence.item.title, "EXCLUDED",
      "해당 회차의 일정 준비는 이미 완료됨 · 본 일정은 시작 시각에 다시 판단", occurrence.item.id, { priorityLayer: 2 }));
    return false;
  });
  if (nextSchedule) {
    const minutesUntil = Math.ceil((nextSchedule.startAt.getTime() - now.getTime()) / minuteMs);
    if (minutesUntil <= 15) {
      const prepared: PreparedCandidate = {
        label: nextSchedule.item.title,
        candidate: {
          action: `${nextSchedule.item.title} 일정을 준비할 것.`,
          expectedMinutes: Math.max(1, Math.min(10, minutesUntil)),
          sourceType: "SCHEDULE",
          sourceId: nextSchedule.item.id,
          scheduleOccurrenceStartAt: nextSchedule.startAt.toISOString(),
          schedulePhase: "PREPARATION",
          executionConstraints: nextSchedule.item.executionConstraints,
          actionType: "COMPLETION",
          selectionReason: "15분 안에 시작하는 고정 일정 준비가 필요하여 선택됨",
          deadline: nextSchedule.startAt.toISOString(),
          trigger: "곧 일정이 시작되므로,",
        },
      };
      const adjusted = applyRecentResolution(prepared, recentTickets, now, context.userContext);
      if (adjusted.candidate) {
        decisions.push(createCandidateDecision("SCHEDULE", prepared.label, "SELECTED", adjusted.reason, prepared.candidate.sourceId, { priorityLayer: 2 }));
        appendPrioritySkippedDecisions(decisions, tasks, idealRoutines, "15분 안에 시작하는 일정 준비가 우선됨", context);
        return createPlannerPlan(context, adjusted.candidate.candidate, availableMinutes, decisions);
      }
      decisions.push(createCandidateDecision("SCHEDULE", prepared.label, "EXCLUDED", adjusted.reason, prepared.candidate.sourceId, { priorityLayer: 2 }));
    }
  }

  const taskCandidates: PreparedTaskCandidate[] = [];
  for (const task of tasks) {
    const prepared = createTaskCandidate(task, availableMinutes, now, recentTickets);
    if (!prepared) {
      const reason = isTaskSourceCompleted(task, recentTickets)
        ? "이미 완료된 Task 원본 또는 완료 이력" : "가용시간이 5분 미만이거나 남은 수행시간이 1분 미만";
      decisions.push(createTaskDecision(task, "EXCLUDED", reason, now, recentTickets));
      continue;
    }
    const adjusted = applyRecentResolution(prepared, recentTickets, now, context.userContext);
    if (!adjusted.candidate) {
      decisions.push(createTaskDecision(task, "EXCLUDED", adjusted.reason, now, recentTickets));
      continue;
    }
    const candidate = adjusted.candidate;
    taskCandidates.push(candidate);
    decisions.push({ ...createTaskDecision(task, "ELIGIBLE", adjusted.reason, now, recentTickets),
      originalMinutes: prepared.candidate.expectedMinutes, adjustedMinutes: candidate.candidate.expectedMinutes });
  }
  taskCandidates.sort(compareTaskCandidates);
  const urgentTasks = taskCandidates.filter((candidate) => candidate.deadlineTier <= 3);
  const normalTasks = taskCandidates.filter((candidate) => candidate.deadlineTier > 3);

  const routineCandidates: PreparedRoutineCandidate[] = [];
  for (const routine of idealRoutines) {
    const window = resolveRoutineWindow(routine, now);
    if (!window) {
      decisions.push(createCandidateDecision("ROUTINE", routine.title, "EXCLUDED", routine.enabled ? "현재 루틴 시간대가 아님" : "비활성화된 루틴", routine.id, { priorityLayer: 4 }));
      continue;
    }
    const detailedStep = getCurrentRoutineStep(routine, window, recentTickets);
    if ((routine.steps?.length ?? 0) > 0 && !detailedStep) {
      decisions.push(createCandidateDecision("ROUTINE", routine.title, "EXCLUDED", "현재 루틴 구간의 상세 단계를 모두 완료함", routine.id, { priorityLayer: 4 }));
      continue;
    }
    if ((routine.steps?.length ?? 0) === 0 && wasRoutineResolvedInWindow(routine.id, window, recentTickets)) {
      decisions.push(createCandidateDecision("ROUTINE", routine.title, "EXCLUDED", "현재 루틴 구간에서 이미 처리됨", routine.id, { priorityLayer: 4 }));
      continue;
    }
    const windowRemaining = Math.floor((window.endAt.getTime() - now.getTime()) / minuteMs);
    const requestedMinutes = detailedStep?.progress.remainingMinutes ?? maximumWorkMinutes;
    const expectedMinutes = Math.min(requestedMinutes, maximumWorkMinutes, windowRemaining, availableMinutes);
    const minimumRoutineMinutes = detailedStep ? 1 : minimumWorkMinutes;
    if (expectedMinutes < minimumRoutineMinutes) {
      decisions.push(createCandidateDecision(
        "ROUTINE",
        routine.title,
        "EXCLUDED",
        detailedStep ? "상세 단계를 실행할 시간이 남지 않음" : "가용시간 또는 루틴에 남은 시간이 5분 미만",
        routine.id,
        { priorityLayer: 4 },
      ));
      continue;
    }
    const actionTitle = detailedStep?.step.title ?? routine.title;
    const actionType = detailedStep?.step.actionType ?? inferRoutineActionType(routine);
    const stageReason = detailedStep
      ? ` · 상세 단계 ${detailedStep.index + 1}/${routine.steps?.length ?? 0}`
      : "";
    const prepared: PreparedRoutineCandidate = {
      routine,
      stepProgress: detailedStep?.progress,
      label: routine.title,
      candidate: {
        action: createDirectiveAction(actionTitle, actionType, expectedMinutes),
        expectedMinutes,
        sourceType: "ROUTINE",
        sourceId: routine.id,
        actionType,
        executionConstraints: mergeExecutionConstraints(routine.executionConstraints, detailedStep?.step.executionConstraints),
        selectionReason: `${routine.timingMode === "FIXED" ? "고정형" : "유연형"} 루틴 시간대${stageReason} · 우선순위 ${routine.priority} · 가용 ${availableMinutes}분`,
        deadline: window.endAt.toISOString(),
        trigger: "지금은 이 루틴의 시간대이므로,",
        routineTitle: routine.title,
        routineStepId: detailedStep?.step.id,
        routineStepIndex: detailedStep ? detailedStep.index + 1 : 1,
        routineStepCount: routine.steps?.length || 1,
        routineOccurrenceStartAt: window.startAt.toISOString(),
        routineOccurrenceEndAt: window.endAt.toISOString(),
      },
    };
    const adjusted = applyRecentResolution(prepared, recentTickets, now, context.userContext);
    if (!adjusted.candidate) {
      decisions.push(createCandidateDecision("ROUTINE", routine.title, "EXCLUDED", adjusted.reason, routine.id, { priorityLayer: 4 }));
      continue;
    }
    const candidate = adjusted.candidate;
    routineCandidates.push(candidate);
    decisions.push({ ...createCandidateDecision("ROUTINE", routine.title, "ELIGIBLE", adjusted.reason, routine.id, { priorityLayer: 4 }),
      originalMinutes: prepared.candidate.expectedMinutes, adjustedMinutes: candidate.candidate.expectedMinutes });
  }
  routineCandidates.sort((left, right) => right.routine.priority - left.routine.priority
    || compareStableIds(left.routine.id, right.routine.id));

  const urgentTask = urgentTasks[0];
  if (urgentTask) {
    const reason = createSelectedTaskReason(urgentTask, urgentTasks);
    const selected = { ...urgentTask.candidate, selectionReason: reason };
    finalizeTierDecisions(decisions, selected, reason, ["ROUTINE"]);
    for (const normalTask of normalTasks) {
      const decision = decisions.find((item) => item.disposition === "ELIGIBLE" && item.sourceType === "TASK" && item.sourceId === normalTask.task.id);
      if (decision) {
        decision.disposition = "SKIPPED";
        decision.reason = `${reason} · 일반 Task보다 긴급 Task가 우선`;
      }
    }
    return createPlannerPlan(context, selected, availableMinutes, decisions);
  }

  const routine = routineCandidates[0];
  if (routine) {
    const detailedStage = routine.candidate.routineStepCount && routine.candidate.routineStepCount > 1
      ? ` · 상세 단계 ${routine.candidate.routineStepIndex}/${routine.candidate.routineStepCount}`
      : "";
    const baseReason = `현재 실행 가능한 ${routine.routine.timingMode === "FIXED" ? "고정형" : "유연형"} 루틴이 있으며 긴급 할 일이 없어 선택됨${detailedStage}`;
    const progressReason = routine.candidate.actionType === "DURATION" && routine.stepProgress
      ? ` · 단계 누적 ${routine.stepProgress.completedMinutes}/${routine.stepProgress.targetMinutes}분 · 남은 ${routine.stepProgress.remainingMinutes}분` : "";
    const reason = `${baseReason}${progressReason}${routine.adjustmentReason ? ` · ${routine.adjustmentReason}` : ""}`;
    const selected = { ...routine.candidate, selectionReason: reason };
    finalizeTierDecisions(decisions, selected, reason, ["TASK"]);
    return createPlannerPlan(context, selected, availableMinutes, decisions);
  }

  const normalTask = normalTasks[0];
  if (normalTask) {
    const reason = createSelectedTaskReason(normalTask, normalTasks);
    const selected = { ...normalTask.candidate, selectionReason: reason };
    finalizeTierDecisions(decisions, selected, reason, []);
    return createPlannerPlan(context, selected, availableMinutes, decisions);
  }

  const fallback = selectSystemFallback(recentTickets, availableMinutes, now, nextBoundaryAt, decisions, context.settings, effectiveContext);
  if (!fallback) return createDeferredPlan(context, availableMinutes, decisions, "현재 상태에서 수행 가능한 등록 행동과 System fallback이 없어 발행을 보류합니다.");
  const adjustedFallback = applyRecentResolution({ label: fallback.action, candidate: fallback }, recentTickets, now, context.userContext);
  if (!adjustedFallback.candidate) return createDeferredPlan(context, availableMinutes, decisions, adjustedFallback.reason);
  const selectedFallback = adjustedFallback.candidate.candidate;
  decisions.push({ ...createCandidateDecision("SYSTEM", selectedFallback.action, "SELECTED", selectedFallback.selectionReason ?? "실행 가능한 등록 항목 없음", selectedFallback.sourceId, { priorityLayer: 6 }),
    originalMinutes: fallback.expectedMinutes, adjustedMinutes: selectedFallback.expectedMinutes });
  return createPlannerPlan(context, selectedFallback, availableMinutes, decisions);
}

/** Chooses one deterministic current action while preserving the original Planner API. */
export function planNextTicket(context: PlannerContext): TicketCandidate | null {
  const result = planNextTicketWithDecision(context);
  return result.kind === "DIRECTIVE" ? result.candidate : null;
}
