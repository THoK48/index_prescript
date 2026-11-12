import {
  getScheduleTicketOccurrenceStart,
  getScheduleTicketPhase,
  getTaskCompletedMinutes,
  restoreScheduleCompletion,
  restoreTaskCompletion,
} from "./sourceCompletion.ts";
import { createDefaultUserContext, normalizeUserContext, type ExecutionConstraints, type UserContext } from "./userContext.ts";
import { getRoutineStepProgress, getRoutineTicketWindow } from "./routineProgress.ts";

export type TicketStatus = "ACTIVE" | "COMPLETED" | "FAILED" | "INVALID" | "CANCELLED";
export type FailureReason =
  | "time_shortage"
  | "physical_condition"
  | "schedule_changed"
  | "place_or_tools"
  | "too_difficult"
  | "time_elapsed"
  | "other";

export type TicketSourceType = "TASK" | "SCHEDULE" | "ROUTINE" | "SYSTEM";
export type RoutineTimingMode = "FIXED" | "FLEXIBLE";
export type RoutineActionType = "DURATION" | "COMPLETION" | "MOVEMENT";
/** Preparation and actual attendance share an occurrence but have separate completion meanings. */
export type ScheduleDirectivePhase = "PREPARATION" | "EXECUTION";

/** Planner-quality feedback, distinct from user execution failure reasons. */
export type InvalidDirectiveReason =
  | "TIME_IMPOSSIBLE"
  | "BAD_PRIORITY"
  | "ALREADY_DONE"
  | "CONTEXT_MISMATCH"
  | "TOO_REPETITIVE"
  | "OTHER";

/** Checks feedback reasons at the storage and transition boundaries. */
export function isInvalidDirectiveReason(value: unknown): value is InvalidDirectiveReason {
  return value === "TIME_IMPOSSIBLE" || value === "BAD_PRIORITY" || value === "ALREADY_DONE"
    || value === "CONTEXT_MISMATCH" || value === "TOO_REPETITIVE" || value === "OTHER";
}

/** Pauses registered sources for thirty minutes after quality feedback; System actions advance their rotation. */
export function getInvalidDirectiveCooldownUntil(sourceType: TicketSourceType, reportedAt: Date): Date | null {
  return sourceType === "SYSTEM" ? null : new Date(reportedAt.getTime() + 30 * 60_000);
}

export interface RecurrenceRule {
  frequency: "NONE" | "DAILY" | "WEEKLY";
  daysOfWeek?: number[];
}

export interface Ticket {
  id: string;
  sequence: number;
  recipient: string;
  deadline: string | null;
  trigger: string;
  action: string;
  expectedMinutes: number;
  sourceType: TicketSourceType;
  sourceId?: string;
  /** Stable occurrence identity shared by schedule preparation and execution, even across midnight. */
  scheduleOccurrenceStartAt?: string;
  schedulePhase?: ScheduleDirectivePhase;
  /** A completed execution block may leave its Task unfinished; preparations never finish a Schedule. */
  sourceCompleted?: boolean;
  /** Snapshot of explicit requirements and action style at issuance. */
  executionConstraints?: ExecutionConstraints;
  actionType?: RoutineActionType;
  selectionReason?: string;
  /** Optional parent metadata shown only inside the directive information panel. */
  routineTitle?: string;
  routineStepId?: string;
  routineStepIndex?: number;
  routineStepCount?: number;
  /** Original occurrence boundaries preserve progress across midnight and delayed completion reports. */
  routineOccurrenceStartAt?: string;
  routineOccurrenceEndAt?: string;
  /** COMPLETED can describe a partial duration block without finishing the whole detailed step. */
  routineStepCompleted?: boolean;
  status: TicketStatus;
  createdAt: string;
  /** Optional reminder extension that preserves the original issue time and planned Task duration. */
  extendedUntil?: string;
  completedAt?: string;
  /** Context cancellation is not a user execution result or a Planner-quality report. */
  cancelledAt?: string;
  cancellationReason?: "CONTEXT_CHANGED" | "DUPLICATE_ACTIVE";
  failureReason?: FailureReason;
  cooldownUntil?: string;
  /** Quality feedback does not use completedAt or failureReason and does not advance Task progress. */
  invalidReason?: InvalidDirectiveReason;
  invalidatedAt?: string;
  /** Preserves the original decision even after the rolling Planner audit history is trimmed. */
  invalidDecision?: PlannerDecisionRecord;
}

/** Stable source identity for the rare unlimited-duration System fallback. */
export const happinessEasterEggSourceId = "fallback:easter-egg-happiness";

/** Reports whether a directive intentionally has no expected completion boundary. */
export function isUnlimitedDurationTicket(ticket: Pick<Ticket, "sourceType" | "sourceId">): boolean {
  return ticket.sourceType === "SYSTEM" && ticket.sourceId === happinessEasterEggSourceId;
}

export interface Task {
  id: string;
  title: string;
  dueAt?: string;
  estimatedMinutes?: number;
  completedMinutes: number;
  importance: 1 | 2 | 3 | 4 | 5;
  status: "TODO" | "DOING" | "DONE";
  /** Explicit whole-Task completion is separate from accumulated completedMinutes. */
  completedAt?: string;
  /** Explicit reopening starts a fresh progress cycle without removing previous execution history. */
  reopenedAt?: string;
  category: "work" | "study" | "personal" | "health" | "other";
  executionConstraints?: ExecutionConstraints;
}

export interface LocalScheduleItem {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  type: "work" | "class" | "appointment" | "commute" | "exercise" | "other";
  recurrence?: RecurrenceRule;
  /** Finishes only a one-off schedule, never the entire recurring template. */
  completedAt?: string;
  /** ISO start times identify individually completed recurring occurrences. */
  completedOccurrenceStarts?: string[];
  executionConstraints?: ExecutionConstraints;
}

export interface IdealRoutine {
  id: string;
  title: string;
  startTime: string;
  endTime?: string;
  daysOfWeek: number[];
  category: "sleep" | "meal" | "work" | "study" | "exercise" | "personal" | "other";
  priority: number;
  enabled: boolean;
  /** Locked routines can be edited directly but are never moved by automatic downstream shifting. */
  locked?: boolean;
  /** FIXED starts constrain Planner time; FLEXIBLE routines remain candidates throughout their window. */
  timingMode: RoutineTimingMode;
  /** Optional ordered actions; an empty list preserves the original single-action routine. */
  steps?: RoutineStep[];
  /** Date-scoped schedule changes leave the recurring template untouched. */
  dateOverrides?: RoutineDateOverride[];
  executionConstraints?: ExecutionConstraints;
}

/** One user-authored action inside an ordered detailed routine. */
export interface RoutineStep {
  id: string;
  title: string;
  actionType: RoutineActionType;
  expectedMinutes: number;
  executionConstraints?: ExecutionConstraints;
}

/** One local-date override for a recurring routine occurrence. */
export interface RoutineDateOverride {
  dateKey: string;
  startTime: string;
  endTime?: string;
  /** Moves a late shifted occurrence into the following local date without changing the template weekdays. */
  startDayOffset?: 0 | 1;
}

/** One deterministic user-editable action used when no registered item can run. */
export interface SystemFallback {
  id: string;
  action: string;
  expectedMinutes: number;
  executionConstraints?: ExecutionConstraints;
}

const defaultSystemFallbackTemplates: readonly SystemFallback[] = [
  { id: "tidy", action: "주변을 5분간 정리할 것.", expectedMinutes: 5 },
  { id: "water", action: "물을 한 잔 마실 것.", expectedMinutes: 2 },
  { id: "walk", action: "5분간 가볍게 걸을 것.", expectedMinutes: 5, executionConstraints: { requiredCapabilities: ["EXERCISE"], effort: "LIGHT" } },
  { id: "rest", action: "5분간 잠시 휴식할 것.", expectedMinutes: 5 },
  { id: "stretch", action: "5분간 스트레칭할 것.", expectedMinutes: 5, executionConstraints: { requiredCapabilities: ["EXERCISE"], effort: "LIGHT" } },
];

/** Returns mutable copies so settings edits never mutate the shared default templates. */
export function createDefaultSystemFallbacks(): SystemFallback[] {
  return defaultSystemFallbackTemplates.map((fallback) => ({ ...fallback, executionConstraints: fallback.executionConstraints
    ? { ...fallback.executionConstraints, requiredCapabilities: [...(fallback.executionConstraints.requiredCapabilities ?? [])] } : undefined }));
}

export interface Settings {
  userName: string;
  preferredBedtime: string;
  preferredWakeTime: string;
  tone: "dry" | "formal";
  systemFallbacks: SystemFallback[];
}

export type PlannerCandidateDisposition = "SELECTED" | "ELIGIBLE" | "EXCLUDED" | "SKIPPED";

/** Deadline buckets: overdue, six hours, one day, three days, one week, later/undated. */
export type TaskDeadlineTier = 0 | 1 | 2 | 3 | 4 | 5;

/** Ordered Planner layers: current schedule, preparation, urgent Task, Routine, normal Task, System. */
export type PlannerPriorityLayer = 1 | 2 | 3 | 4 | 5 | 6;

export interface PlannerCandidateDecision {
  sourceType: TicketSourceType;
  sourceId?: string;
  label: string;
  /** Legacy audit compatibility only; the tier-based Planner writes null and never compares scores. */
  score: number | null;
  disposition: PlannerCandidateDisposition;
  reason: string;
  /** Optional sort inputs retained for reproducing decisions made by the tier-based Planner. */
  priorityLayer?: PlannerPriorityLayer;
  deadlineTier?: TaskDeadlineTier;
  importance?: Task["importance"];
  lastExecutedAt?: string | null;
  /** Only duration-based work is shortened; audit keeps both block sizes. */
  originalMinutes?: number;
  adjustedMinutes?: number;
}

export interface PlannerDecisionDraft {
  evaluatedAt: string;
  availableMinutes: number;
  selectedAction: string;
  selectedReason: string;
  candidates: PlannerCandidateDecision[];
  userContext?: UserContext;
  result?: "DIRECTIVE" | "DEFERRED";
}

/** A normal Planner outcome with no ACTIVE, retained separately from issued-ticket history. */
export interface PlannerDeferral {
  reason: string;
  resumeAt?: string;
  decision: PlannerDecisionDraft;
}

export interface PlannerDecisionRecord extends PlannerDecisionDraft {
  /** A normal DEFERRED decision has no Ticket; actual issuance records retain their source Ticket ID. */
  ticketId?: string;
}

export interface AppState {
  userContext: UserContext;
  plannerDeferral?: PlannerDeferral;
  tickets: Ticket[];
  tasks: Task[];
  localScheduleItems: LocalScheduleItem[];
  idealRoutines: IdealRoutine[];
  plannerDecisions: PlannerDecisionRecord[];
  settings: Settings;
}

export interface TicketCandidate {
  action: string;
  expectedMinutes: number;
  sourceType: TicketSourceType;
  sourceId?: string;
  executionConstraints?: ExecutionConstraints;
  actionType?: RoutineActionType;
  /** Transient audit input; the persisted decision stores the final duration change. */
  originalExpectedMinutes?: number;
  scheduleOccurrenceStartAt?: string;
  schedulePhase?: ScheduleDirectivePhase;
  selectionReason?: string;
  deadline?: string;
  trigger?: string;
  /** Detailed-routine context is persisted on the issued Ticket but never added to the main action text. */
  routineTitle?: string;
  routineStepId?: string;
  routineStepIndex?: number;
  routineStepCount?: number;
  routineOccurrenceStartAt?: string;
  routineOccurrenceEndAt?: string;
}

export type TransitionResult =
  | { kind: "success"; state: AppState }
  | { kind: "conflict"; state: AppState };

/** Returns the only active ticket in a normalized app state. */
export function getActiveTicket(state: AppState): Ticket | null {
  return state.tickets.find((ticket) => ticket.status === "ACTIVE") ?? null;
}

/** Returns the effective expected-end instant, including an acknowledged continuation when present. */
export function getTicketExpectedEndAt(ticket: Ticket): Date {
  const plannedEnd = new Date(new Date(ticket.createdAt).getTime() + ticket.expectedMinutes * 60_000);
  const extendedEnd = ticket.extendedUntil ? new Date(ticket.extendedUntil) : null;
  return extendedEnd && !Number.isNaN(extendedEnd.getTime()) && extendedEnd > plannedEnd
    ? extendedEnd
    : plannedEnd;
}

export interface ActiveTicketStaleness {
  ageMinutes: number;
  reason: string;
}

/** Returns the deterministic source cooldown expiry for failures that should pause reissuance. */
export function getFailureCooldownUntil(reason: FailureReason, failedAt: Date): Date | null {
  const cooldownMinutes: Partial<Record<FailureReason, number>> = {
    schedule_changed: 240,
    physical_condition: 240,
    place_or_tools: 120,
    time_elapsed: 120,
  };
  const minutes = cooldownMinutes[reason];
  return minutes === undefined ? null : new Date(failedAt.getTime() + minutes * 60_000);
}

/** Explains why an active ticket should be reviewed instead of being silently discarded. */
export function getActiveTicketStaleness(ticket: Ticket, now: Date): ActiveTicketStaleness | null {
  if (ticket.status !== "ACTIVE") return null;
  if (isUnlimitedDurationTicket(ticket)) return null;
  const issuedAt = new Date(ticket.createdAt);
  if (Number.isNaN(issuedAt.getTime())) return null;
  const ageMinutes = Math.max(0, Math.floor((now.getTime() - issuedAt.getTime()) / 60_000));
  const deadline = ticket.deadline ? new Date(ticket.deadline) : null;
  if (deadline && !Number.isNaN(deadline.getTime()) && deadline > issuedAt && deadline <= now) {
    return { ageMinutes, reason: "지령의 마감 시각이 지났습니다." };
  }
  const crossedLocalDate = issuedAt.getFullYear() !== now.getFullYear()
    || issuedAt.getMonth() !== now.getMonth()
    || issuedAt.getDate() !== now.getDate();
  if (crossedLocalDate) return { ageMinutes, reason: "이전 날짜에 발행된 지령입니다." };
  const staleAfterMinutes = Math.max(120, ticket.expectedMinutes * 3);
  return ageMinutes >= staleAfterMinutes
    ? { ageMinutes, reason: `발행 후 ${ageMinutes}분이 경과했습니다.` }
    : null;
}

/** Issues exactly one ticket from a Planner candidate. */
export function issueTicket(
  state: AppState,
  candidate: TicketCandidate,
  now: Date,
  id: string,
  plannerDecision?: PlannerDecisionDraft,
): TransitionResult {
  if (getActiveTicket(state) || !candidate.action.trim() || candidate.expectedMinutes < 1 || candidate.expectedMinutes > 240) {
    return { kind: "conflict", state };
  }
  const sequence = Math.max(0, ...state.tickets.map((ticket) => ticket.sequence)) + 1;
  const ticket: Ticket = {
    id,
    sequence,
    recipient: state.settings.userName.trim() || "사용자",
    deadline: candidate.deadline ?? null,
    trigger: candidate.trigger ?? "지금,",
    action: candidate.action,
    expectedMinutes: candidate.expectedMinutes,
    sourceType: candidate.sourceType,
    sourceId: candidate.sourceId,
    executionConstraints: candidate.executionConstraints,
    actionType: candidate.actionType,
    scheduleOccurrenceStartAt: candidate.scheduleOccurrenceStartAt,
    schedulePhase: candidate.schedulePhase,
    selectionReason: candidate.selectionReason,
    routineTitle: candidate.routineTitle,
    routineStepId: candidate.routineStepId,
    routineStepIndex: candidate.routineStepIndex,
    routineStepCount: candidate.routineStepCount,
    routineOccurrenceStartAt: candidate.routineOccurrenceStartAt,
    routineOccurrenceEndAt: candidate.routineOccurrenceEndAt,
    status: "ACTIVE",
    createdAt: now.toISOString(),
  };
  const plannerDecisions = plannerDecision
    ? [{ ...plannerDecision, ticketId: id }, ...(state.plannerDecisions ?? [])].slice(0, 50)
    : (state.plannerDecisions ?? []);
  return {
    kind: "success",
    state: { ...state, plannerDeferral: undefined, tickets: [ticket, ...state.tickets], plannerDecisions },
  };
}

/** Updates original-source progress/completion and Ticket history together before the next Planner pass. */
export function completeTicket(state: AppState, id: string, now: Date): TransitionResult {
  const activeTicket = getActiveTicket(state);
  if (activeTicket?.id !== id) return { kind: "conflict", state };
  const tasks = activeTicket.sourceType === "TASK" && activeTicket.sourceId
    ? state.tasks.map((task): Task => {
      if (task.id !== activeTicket.sourceId) return task;
      const completedMinutes = getTaskCompletedMinutes(task, state.tickets) + activeTicket.expectedMinutes;
      const isDone = task.status === "DONE" || task.completedAt !== undefined
        || task.estimatedMinutes === undefined || completedMinutes >= task.estimatedMinutes;
      return {
        ...task,
        completedMinutes,
        status: isDone ? "DONE" : "DOING",
        ...(isDone ? { completedAt: task.completedAt ?? now.toISOString() } : {}),
      };
    })
    : state.tasks;
  const schedule = activeTicket.sourceType === "SCHEDULE"
    ? state.localScheduleItems.find((item) => item.id === activeTicket.sourceId) : undefined;
  const schedulePhase = activeTicket.sourceType === "SCHEDULE" ? getScheduleTicketPhase(activeTicket) : undefined;
  const scheduleOccurrenceStartAt = schedule ? getScheduleTicketOccurrenceStart(schedule, activeTicket) : undefined;
  const localScheduleItems = schedule && schedulePhase === "EXECUTION"
    ? state.localScheduleItems.map((item) => {
      if (item.id !== schedule.id) return item;
      if (!item.recurrence || item.recurrence.frequency === "NONE") {
        return { ...item, completedAt: now.toISOString() };
      }
      return scheduleOccurrenceStartAt ? {
        ...item,
        completedOccurrenceStarts: [...new Set([...(item.completedOccurrenceStarts ?? []), scheduleOccurrenceStartAt])].sort(),
      } : item;
    })
    : state.localScheduleItems;
  const sourceCompleted = activeTicket.sourceType === "TASK"
    ? tasks.find((task) => task.id === activeTicket.sourceId)?.status === "DONE"
    : schedulePhase === undefined ? undefined : schedulePhase === "EXECUTION";
  const routine = activeTicket.sourceType === "ROUTINE"
    ? state.idealRoutines.find((item) => item.id === activeTicket.sourceId) : undefined;
  const routineStep = routine?.steps?.find((step) => step.id === activeTicket.routineStepId);
  const routineWindow = routine ? getRoutineTicketWindow(routine, activeTicket) : null;
  const routineStepCompleted = routine && routineStep && routineWindow
    ? getRoutineStepProgress(routine, routineStep, routineWindow, [
      { ...activeTicket, status: "COMPLETED" }, ...state.tickets,
    ]).isCompleted : undefined;
  return {
    kind: "success",
    state: {
      ...state,
      tasks,
      localScheduleItems,
      tickets: state.tickets.map((ticket): Ticket => ticket.id === id
        ? {
          ...ticket,
          status: "COMPLETED",
          completedAt: now.toISOString(),
          ...(sourceCompleted !== undefined ? { sourceCompleted } : {}),
          ...(schedulePhase ? { schedulePhase, scheduleOccurrenceStartAt } : {}),
          ...(routineWindow ? { routineOccurrenceStartAt: routineWindow.startAt.toISOString(), routineOccurrenceEndAt: routineWindow.endAt.toISOString() } : {}),
          ...(routineStepCompleted !== undefined ? { routineStepCompleted } : {}),
        }
        : ticket),
    },
  };
}

/** Keeps the ACTIVE directive and moves only its confirmation deadline into the future. */
export function continueTicket(
  state: AppState,
  id: string,
  now: Date,
  extensionMinutes = 10,
): TransitionResult {
  const activeTicket = getActiveTicket(state);
  if (activeTicket?.id !== id || extensionMinutes < 1 || extensionMinutes > 120) {
    return { kind: "conflict", state };
  }
  const currentExpectedEnd = getTicketExpectedEndAt(activeTicket);
  const extensionBase = currentExpectedEnd > now ? currentExpectedEnd : now;
  const extendedUntil = new Date(extensionBase.getTime() + extensionMinutes * 60_000).toISOString();
  return {
    kind: "success",
    state: {
      ...state,
      tickets: state.tickets.map((ticket) => ticket.id === id ? { ...ticket, extendedUntil } : ticket),
    },
  };
}

/** Fails only the active ticket while retaining its reason for future planning. */
export function failTicket(state: AppState, id: string, reason: FailureReason, now: Date): TransitionResult {
  if (getActiveTicket(state)?.id !== id) return { kind: "conflict", state };
  const cooldownUntil = getFailureCooldownUntil(reason, now)?.toISOString();
  return {
    kind: "success",
    state: {
      ...state,
      tickets: state.tickets.map((ticket): Ticket => ticket.id === id
        ? { ...ticket, status: "FAILED", failureReason: reason, completedAt: now.toISOString(), cooldownUntil }
        : ticket),
    },
  };
}

/** Resolves only the active directive as a Planner-quality problem without counting a user failure. */
export function invalidateTicket(
  state: AppState,
  id: string,
  reason: InvalidDirectiveReason,
  now: Date,
): TransitionResult {
  const active = getActiveTicket(state);
  if (active?.id !== id || !isInvalidDirectiveReason(reason)) return { kind: "conflict", state };
  const cooldownUntil = getInvalidDirectiveCooldownUntil(active.sourceType, now)?.toISOString();
  const invalidDecision = state.plannerDecisions.find((decision) => decision.ticketId === id);
  return {
    kind: "success",
    state: {
      ...state,
      tickets: state.tickets.map((ticket): Ticket => ticket.id === id
        ? {
          ...ticket,
          status: "INVALID",
          invalidReason: reason,
          invalidatedAt: now.toISOString(),
          invalidDecision,
          cooldownUntil,
          completedAt: undefined,
          failureReason: undefined,
        }
        : ticket),
    },
  };
}

/** Cancels only the confirmed ACTIVE identity without recording a failure, quality issue, or progress. */
export function cancelTicketForContext(state: AppState, id: string, now: Date): TransitionResult {
  if (getActiveTicket(state)?.id !== id) return { kind: "conflict", state };
  return {
    kind: "success",
    state: { ...state, tickets: state.tickets.map((ticket): Ticket => ticket.id === id ? {
      ...ticket, status: "CANCELLED", cancellationReason: "CONTEXT_CHANGED", cancelledAt: now.toISOString(),
      completedAt: undefined, failureReason: undefined, invalidReason: undefined, invalidatedAt: undefined,
    } : ticket) },
  };
}

/** Repairs duplicate ACTIVE records and restores source completion from history without clock-based completion. */
export function normalizeState(state: AppState): AppState {
  let hasActive = false;
  return {
    ...state,
    userContext: normalizeUserContext(state.userContext),
    plannerDeferral: getActiveTicket(state) ? undefined : state.plannerDeferral,
    tasks: state.tasks.map((task) => restoreTaskCompletion(task, state.tickets)),
    localScheduleItems: state.localScheduleItems.map((item) => restoreScheduleCompletion(item, state.tickets)),
    tickets: state.tickets.map((ticket): Ticket => {
      if (ticket.status !== "ACTIVE") return ticket;
      if (!hasActive) {
        hasActive = true;
        return ticket;
      }
      return { ...ticket, status: "CANCELLED", cancellationReason: "DUPLICATE_ACTIVE" };
    }),
  };
}

/** Creates an empty local-first account with manual ticket issuance. */
export function createInitialState(): AppState {
  return {
    userContext: createDefaultUserContext(),
    plannerDeferral: undefined,
    tickets: [],
    tasks: [],
    localScheduleItems: [],
    idealRoutines: [],
    plannerDecisions: [],
    settings: {
      userName: "사용자",
      preferredBedtime: "23:30",
      preferredWakeTime: "07:30",
      tone: "dry",
      systemFallbacks: createDefaultSystemFallbacks(),
    },
  };
}
