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
  selectionReason?: string;
  status: TicketStatus;
  createdAt: string;
  completedAt?: string;
  failureReason?: FailureReason;
  cooldownUntil?: string;
  /** Quality feedback does not use completedAt or failureReason and does not advance Task progress. */
  invalidReason?: InvalidDirectiveReason;
  invalidatedAt?: string;
  /** Preserves the original decision even after the rolling Planner audit history is trimmed. */
  invalidDecision?: PlannerDecisionRecord;
}

export interface Task {
  id: string;
  title: string;
  dueAt?: string;
  estimatedMinutes?: number;
  completedMinutes: number;
  importance: 1 | 2 | 3 | 4 | 5;
  status: "TODO" | "DOING" | "DONE";
  category: "work" | "study" | "personal" | "health" | "other";
}

export interface LocalScheduleItem {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  type: "work" | "class" | "appointment" | "commute" | "exercise" | "other";
  recurrence?: RecurrenceRule;
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
}

export interface Settings {
  userName: string;
  preferredBedtime: string;
  preferredWakeTime: string;
  tone: "dry" | "formal";
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
}

export interface PlannerDecisionDraft {
  evaluatedAt: string;
  availableMinutes: number;
  selectedAction: string;
  selectedReason: string;
  candidates: PlannerCandidateDecision[];
}

export interface PlannerDecisionRecord extends PlannerDecisionDraft {
  ticketId: string;
}

export interface AppState {
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
  selectionReason?: string;
  deadline?: string;
  trigger?: string;
}

export type TransitionResult =
  | { kind: "success"; state: AppState }
  | { kind: "conflict"; state: AppState };

/** Returns the only active ticket in a normalized app state. */
export function getActiveTicket(state: AppState): Ticket | null {
  return state.tickets.find((ticket) => ticket.status === "ACTIVE") ?? null;
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
    selectionReason: candidate.selectionReason,
    status: "ACTIVE",
    createdAt: now.toISOString(),
  };
  const plannerDecisions = plannerDecision
    ? [{ ...plannerDecision, ticketId: id }, ...(state.plannerDecisions ?? [])].slice(0, 50)
    : (state.plannerDecisions ?? []);
  return {
    kind: "success",
    state: { ...state, tickets: [ticket, ...state.tickets], plannerDecisions },
  };
}

/** Completes the active ticket and advances its source Task by the ticket duration. */
export function completeTicket(state: AppState, id: string, now: Date): TransitionResult {
  const activeTicket = getActiveTicket(state);
  if (activeTicket?.id !== id) return { kind: "conflict", state };
  const tasks = activeTicket.sourceType === "TASK" && activeTicket.sourceId
    ? state.tasks.map((task): Task => {
      if (task.id !== activeTicket.sourceId) return task;
      const completedMinutes = task.completedMinutes + activeTicket.expectedMinutes;
      const isDone = task.estimatedMinutes !== undefined && completedMinutes >= task.estimatedMinutes;
      return { ...task, completedMinutes, status: isDone ? "DONE" : "DOING" };
    })
    : state.tasks;
  return {
    kind: "success",
    state: {
      ...state,
      tasks,
      tickets: state.tickets.map((ticket): Ticket => ticket.id === id
        ? { ...ticket, status: "COMPLETED", completedAt: now.toISOString() }
        : ticket),
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

/** Repairs duplicate active tickets without discarding ticket history. */
export function normalizeState(state: AppState): AppState {
  let hasActive = false;
  return {
    ...state,
    tickets: state.tickets.map((ticket): Ticket => {
      if (ticket.status !== "ACTIVE") return ticket;
      if (!hasActive) {
        hasActive = true;
        return ticket;
      }
      return { ...ticket, status: "CANCELLED" };
    }),
  };
}

/** Creates an empty local-first account with manual ticket issuance. */
export function createInitialState(): AppState {
  return {
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
    },
  };
}
