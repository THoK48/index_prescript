import {
  createInitialState,
  getInvalidDirectiveCooldownUntil,
  isInvalidDirectiveReason,
  normalizeState,
  type AppState,
  type FailureReason,
  type LocalScheduleItem,
  type PlannerCandidateDecision,
  type PlannerCandidateDisposition,
  type PlannerDecisionRecord,
  type PlannerPriorityLayer,
  type Task,
  type TaskDeadlineTier,
  type Ticket,
  type TicketSourceType,
  type TicketStatus,
} from "./ticketMachine.ts";

export const currentStorageKey = "ticketPlannerV2";
export const previousStorageKey = "directiveTerminalV1";
export const backupFormat = "directive-terminal-backup";

/** Describes the portable envelope used for full-state backup files. */
export interface AppStateBackup {
  format: typeof backupFormat;
  version: 1;
  exportedAt: string;
  state: AppState;
}

/** Checks the minimum shape needed before treating JSON as a saved object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks whether persisted text is a supported ticket source type. */
function isTicketSourceType(value: unknown): value is TicketSourceType {
  return value === "TASK" || value === "SCHEDULE" || value === "ROUTINE" || value === "SYSTEM";
}

/** Checks whether persisted text is a supported Planner candidate disposition. */
function isPlannerCandidateDisposition(value: unknown): value is PlannerCandidateDisposition {
  return value === "SELECTED" || value === "ELIGIBLE" || value === "EXCLUDED" || value === "SKIPPED";
}

/** Narrows optional deadline buckets without trusting arbitrary numbers in imported JSON. */
function isTaskDeadlineTier(value: unknown): value is TaskDeadlineTier {
  return value === 0 || value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

/** Narrows optional layer identifiers from tier-based Planner audit records. */
function isPlannerPriorityLayer(value: unknown): value is PlannerPriorityLayer {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5 || value === 6;
}

/** Narrows a saved Task importance to the same one-through-five range used by the domain. */
function isTaskImportance(value: unknown): value is Task["importance"] {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

/** Recovers valid Planner audit records while ignoring malformed optional diagnostics. */
function parsePlannerDecisionRecords(value: unknown): PlannerDecisionRecord[] {
  if (!Array.isArray(value)) return [];
  const records: PlannerDecisionRecord[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.ticketId !== "string" || typeof raw.evaluatedAt !== "string" ||
        typeof raw.availableMinutes !== "number" || typeof raw.selectedAction !== "string" ||
        typeof raw.selectedReason !== "string" || !Array.isArray(raw.candidates)) continue;
    const candidates: PlannerCandidateDecision[] = raw.candidates.flatMap((candidate) => {
      if (!isRecord(candidate) || !isTicketSourceType(candidate.sourceType) ||
          typeof candidate.label !== "string" || !isPlannerCandidateDisposition(candidate.disposition) ||
          typeof candidate.reason !== "string") return [];
      return [{
        sourceType: candidate.sourceType,
        sourceId: typeof candidate.sourceId === "string" ? candidate.sourceId : undefined,
        label: candidate.label,
        score: typeof candidate.score === "number" && Number.isFinite(candidate.score) ? candidate.score : null,
        disposition: candidate.disposition,
        reason: candidate.reason,
        ...(isPlannerPriorityLayer(candidate.priorityLayer) ? { priorityLayer: candidate.priorityLayer } : {}),
        ...(isTaskDeadlineTier(candidate.deadlineTier) ? { deadlineTier: candidate.deadlineTier } : {}),
        ...(isTaskImportance(candidate.importance) ? { importance: candidate.importance } : {}),
        ...(candidate.lastExecutedAt === null || (typeof candidate.lastExecutedAt === "string"
          && Number.isFinite(new Date(candidate.lastExecutedAt).getTime()))
          ? { lastExecutedAt: candidate.lastExecutedAt }
          : {}),
      }];
    });
    records.push({
      ticketId: raw.ticketId,
      evaluatedAt: raw.evaluatedAt,
      availableMinutes: raw.availableMinutes,
      selectedAction: raw.selectedAction,
      selectedReason: raw.selectedReason,
      candidates,
    });
  }
  return records.slice(0, 50);
}

/** Normalizes optional quality feedback while keeping invalid records out of the execution-result fields. */
function normalizeInvalidTicket(ticket: Ticket, decisions: PlannerDecisionRecord[]): Ticket {
  if (ticket.status !== "INVALID") return ticket;
  const reportedAt = ticket.invalidatedAt ?? ticket.completedAt ?? ticket.createdAt;
  const snapshot = parsePlannerDecisionRecords([ticket.invalidDecision])
    .find((decision) => decision.ticketId === ticket.id)
    ?? decisions.find((decision) => decision.ticketId === ticket.id);
  return {
    ...ticket,
    invalidReason: isInvalidDirectiveReason(ticket.invalidReason) ? ticket.invalidReason : "OTHER",
    invalidatedAt: reportedAt,
    invalidDecision: snapshot,
    cooldownUntil: ticket.sourceType === "SYSTEM"
      ? undefined
      : ticket.cooldownUntil ?? getInvalidDirectiveCooldownUntil(ticket.sourceType, new Date(reportedAt))?.toISOString(),
    completedAt: undefined,
    failureReason: undefined,
  };
}

/** Converts v0.1 browser data without losing completed or failed ticket history. */
export function migrateV1State(value: unknown): AppState | null {
  if (!isRecord(value) || !Array.isArray(value.directives) || !Array.isArray(value.tasks) ||
      !Array.isArray(value.scheduleItems) || !isRecord(value.settings)) return null;

  const initial = createInitialState();
  const tickets: Ticket[] = [];
  for (const raw of value.directives) {
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.sequence !== "number" ||
        typeof raw.action !== "string" || typeof raw.createdAt !== "string" ||
        typeof raw.status !== "string") return null;
    tickets.push({
      id: raw.id,
      sequence: raw.sequence,
      recipient: typeof raw.recipient === "string" ? raw.recipient : "사용자",
      deadline: typeof raw.deadline === "string" ? raw.deadline : null,
      trigger: typeof raw.trigger === "string" ? raw.trigger : "지금,",
      action: raw.action,
      expectedMinutes: typeof raw.expectedMinutes === "number" ? raw.expectedMinutes : 10,
      sourceType: "SYSTEM",
      status: raw.status as TicketStatus,
      createdAt: raw.createdAt,
      completedAt: typeof raw.completedAt === "string" ? raw.completedAt : undefined,
      failureReason: typeof raw.failureReason === "string" ? raw.failureReason as FailureReason : undefined,
      cooldownUntil: typeof raw.cooldownUntil === "string" ? raw.cooldownUntil : undefined,
      invalidReason: isInvalidDirectiveReason(raw.invalidReason) ? raw.invalidReason : undefined,
      invalidatedAt: typeof raw.invalidatedAt === "string" ? raw.invalidatedAt : undefined,
    });
  }

  const tasks: Task[] = [];
  for (const raw of value.tasks) {
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.title !== "string") return null;
    tasks.push({
      id: raw.id,
      title: raw.title,
      dueAt: typeof raw.dueAt === "string" ? raw.dueAt : undefined,
      estimatedMinutes: typeof raw.estimatedMinutes === "number" ? raw.estimatedMinutes : undefined,
      completedMinutes: 0,
      importance: typeof raw.importance === "number" ? raw.importance as Task["importance"] : 3,
      status: raw.status === "DONE" || raw.status === "DOING" ? raw.status : "TODO",
      category: typeof raw.category === "string" ? raw.category as Task["category"] : "other",
    });
  }

  const localScheduleItems: LocalScheduleItem[] = [];
  for (const raw of value.scheduleItems) {
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.title !== "string" ||
        typeof raw.startAt !== "string" || typeof raw.endAt !== "string") return null;
    localScheduleItems.push({
      id: raw.id,
      title: raw.title,
      startAt: raw.startAt,
      endAt: raw.endAt,
      type: typeof raw.type === "string" ? raw.type as LocalScheduleItem["type"] : "other",
      recurrence: { frequency: "NONE" },
    });
  }

  const settings = value.settings;
  return normalizeState({
    ...initial,
    tickets: tickets.map((ticket) => normalizeInvalidTicket(ticket, [])),
    tasks,
    localScheduleItems,
    settings: {
      ...initial.settings,
      userName: typeof settings.userName === "string" ? settings.userName : initial.settings.userName,
      preferredBedtime: typeof settings.preferredBedtime === "string" ? settings.preferredBedtime : initial.settings.preferredBedtime,
      preferredWakeTime: typeof settings.preferredWakeTime === "string" ? settings.preferredWakeTime : initial.settings.preferredWakeTime,
      tone: settings.tone === "formal" ? "formal" : "dry",
    },
  });
}

/** Validates the current storage envelope before any write can replace it. */
export function parseV2State(value: unknown): AppState | null {
  if (!isRecord(value) || !Array.isArray(value.tickets) || !Array.isArray(value.tasks) ||
      !Array.isArray(value.localScheduleItems) || !Array.isArray(value.idealRoutines) ||
      !isRecord(value.settings)) return null;
  const parsed = value as unknown as AppState;
  const plannerDecisions = parsePlannerDecisionRecords(value.plannerDecisions);
  return normalizeState({
    tickets: parsed.tickets.map((ticket) => normalizeInvalidTicket(ticket, plannerDecisions)),
    tasks: parsed.tasks.map((task) => ({ ...task, completedMinutes: task.completedMinutes ?? 0 })),
    localScheduleItems: parsed.localScheduleItems,
    idealRoutines: parsed.idealRoutines,
    plannerDecisions,
    settings: parsed.settings,
  });
}

/** Creates a portable, versioned backup envelope around the current local state. */
export function createStateBackup(state: AppState, now: Date): AppStateBackup {
  return {
    format: backupFormat,
    version: 1,
    exportedAt: now.toISOString(),
    state,
  };
}

/** Validates a backup envelope while also accepting raw current or legacy storage exports. */
export function parseStateBackup(value: unknown): AppState | null {
  if (isRecord(value) && value.format === backupFormat && value.version === 1) {
    return parseV2State(value.state);
  }
  return parseV2State(value) ?? migrateV1State(value);
}
