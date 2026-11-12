import { getScheduleOccurrence, getScheduleOccurrences } from "./calendar.ts";
import type { LocalScheduleItem, ScheduleDirectivePhase, Task, Ticket } from "./ticketMachine.ts";

/** Reads a saved timestamp without depending on the current wall clock. */
function timestamp(value: string | undefined): number {
  return value === undefined ? Number.NaN : new Date(value).getTime();
}

/** Finds completed execution blocks for this Task's current, explicitly reopened progress cycle. */
function getTaskCompletionTickets(task: Task, tickets: Ticket[]): Ticket[] {
  const reopenedAt = timestamp(task.reopenedAt);
  return tickets.filter((ticket) => ticket.sourceType === "TASK" && ticket.sourceId === task.id
    && ticket.status === "COMPLETED"
    && (!Number.isFinite(reopenedAt) || timestamp(ticket.createdAt) >= reopenedAt));
}

/** Recovers recorded work without counting failure, feedback, or elapsed wall-clock time as progress. */
export function getTaskCompletedMinutes(task: Task, tickets: Ticket[] = []): number {
  const recorded = Number.isFinite(task.completedMinutes) ? Math.max(0, task.completedMinutes) : 0;
  const historical = getTaskCompletionTickets(task, tickets).reduce((total, ticket) => (
    total + (Number.isFinite(ticket.expectedMinutes) ? Math.max(0, ticket.expectedMinutes) : 0)
  ), 0);
  return Math.max(recorded, historical);
}

/** Distinguishes whole-Task completion from a completed partial execution block. */
export function isTaskSourceCompleted(task: Task, tickets: Ticket[] = []): boolean {
  if (task.status === "DONE" || Number.isFinite(timestamp(task.completedAt))) return true;
  const completed = getTaskCompletionTickets(task, tickets);
  if (completed.some((ticket) => ticket.sourceCompleted === true)) return true;
  if (task.estimatedMinutes === undefined) {
    return completed.some((ticket) => ticket.sourceCompleted !== false);
  }
  return completed.length > 0 && getTaskCompletedMinutes(task, tickets) >= task.estimatedMinutes;
}

/** Returns only the remaining work in the current Task cycle, with a bounded default for unestimated work. */
export function getTaskRemainingMinutes(task: Task, tickets: Ticket[] = []): number {
  if (isTaskSourceCompleted(task, tickets)) return 0;
  return task.estimatedMinutes === undefined ? 25
    : Math.max(0, task.estimatedMinutes - getTaskCompletedMinutes(task, tickets));
}

/** Restores a whole-Task completion marker and progress from source-linked history when reading old storage. */
export function restoreTaskCompletion(task: Task, tickets: Ticket[]): Task {
  const completedMinutes = getTaskCompletedMinutes(task, tickets);
  if (!isTaskSourceCompleted(task, tickets)) {
    return completedMinutes === task.completedMinutes ? task : { ...task, completedMinutes };
  }
  const lastCompletion = getTaskCompletionTickets(task, tickets)
    .map((ticket) => timestamp(ticket.completedAt ?? ticket.createdAt))
    .filter(Number.isFinite).sort((left, right) => right - left)[0];
  const completedAt = task.completedAt ?? (lastCompletion === undefined ? undefined : new Date(lastCompletion).toISOString());
  return { ...task, status: "DONE", completedMinutes, ...(completedAt ? { completedAt } : {}) };
}

/** Separates schedule preparation from attendance, including directives issued before phase metadata existed. */
export function getScheduleTicketPhase(ticket: Ticket): ScheduleDirectivePhase {
  if (ticket.schedulePhase === "PREPARATION" || ticket.schedulePhase === "EXECUTION") return ticket.schedulePhase;
  return ticket.action.trim().endsWith(" 일정을 준비할 것.") ? "PREPARATION" : "EXECUTION";
}

/** Resolves the original occurrence from explicit metadata, its planned boundary, or its issue window. */
export function getScheduleTicketOccurrenceStart(item: LocalScheduleItem, ticket: Ticket): string | undefined {
  const explicitStart = timestamp(ticket.scheduleOccurrenceStartAt);
  if (Number.isFinite(explicitStart)) return new Date(explicitStart).toISOString();
  if (!item.recurrence || item.recurrence.frequency === "NONE") {
    const startAt = timestamp(item.startAt);
    return Number.isFinite(startAt) ? new Date(startAt).toISOString() : undefined;
  }
  const phase = getScheduleTicketPhase(ticket);
  const duration = timestamp(item.endAt) - timestamp(item.startAt);
  const deadline = timestamp(ticket.deadline ?? undefined);
  if (Number.isFinite(deadline) && Number.isFinite(duration) && duration > 0) {
    const possibleStart = new Date(phase === "PREPARATION" ? deadline : deadline - duration);
    const occurrence = getScheduleOccurrence(item, possibleStart);
    if (occurrence?.startAt.getTime() === possibleStart.getTime()) return possibleStart.toISOString();
  }
  const issuedAt = timestamp(ticket.createdAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(duration) || duration <= 0) return undefined;
  const occurrences = getScheduleOccurrences([item], new Date(issuedAt - duration), new Date(issuedAt + 15 * 60_000));
  const occurrence = phase === "PREPARATION"
    ? occurrences.find((value) => value.startAt.getTime() > issuedAt && value.startAt.getTime() <= issuedAt + 15 * 60_000)
    : occurrences.filter((value) => value.startAt.getTime() <= issuedAt && issuedAt < value.endAt.getTime()).at(-1);
  return occurrence?.startAt.toISOString();
}

/** Checks completion by original source and occurrence, never by the replacement Ticket's ID or completion date. */
export function isScheduleOccurrenceCompleted(item: LocalScheduleItem, startAt: Date, tickets: Ticket[]): boolean {
  const isRecurring = item.recurrence !== undefined && item.recurrence.frequency !== "NONE";
  if (!isRecurring && Number.isFinite(timestamp(item.completedAt))) return true;
  const occurrenceStart = startAt.toISOString();
  if (isRecurring && item.completedOccurrenceStarts?.includes(occurrenceStart)) return true;
  return tickets.some((ticket) => ticket.sourceType === "SCHEDULE" && ticket.sourceId === item.id
    && ticket.status === "COMPLETED" && ticket.sourceCompleted !== false
    && getScheduleTicketPhase(ticket) === "EXECUTION"
    && (!isRecurring || getScheduleTicketOccurrenceStart(item, ticket) === occurrenceStart));
}

/** Prevents repeated preparation without suppressing the later execution of that same occurrence. */
export function isScheduleOccurrencePrepared(item: LocalScheduleItem, startAt: Date, tickets: Ticket[]): boolean {
  const occurrenceStart = startAt.toISOString();
  return tickets.some((ticket) => ticket.sourceType === "SCHEDULE" && ticket.sourceId === item.id
    && ticket.status === "COMPLETED" && getScheduleTicketPhase(ticket) === "PREPARATION"
    && getScheduleTicketOccurrenceStart(item, ticket) === occurrenceStart);
}

/** Rebuilds persisted one-off or per-occurrence completion markers without deleting legacy Ticket history. */
export function restoreScheduleCompletion(item: LocalScheduleItem, tickets: Ticket[]): LocalScheduleItem {
  const completed = tickets.filter((ticket) => ticket.sourceType === "SCHEDULE" && ticket.sourceId === item.id
    && ticket.status === "COMPLETED" && ticket.sourceCompleted !== false
    && getScheduleTicketPhase(ticket) === "EXECUTION");
  if (!item.recurrence || item.recurrence.frequency === "NONE") {
    if (Number.isFinite(timestamp(item.completedAt))) return item;
    const completedAt = completed.map((ticket) => timestamp(ticket.completedAt ?? ticket.createdAt))
      .filter(Number.isFinite).sort((left, right) => right - left)[0];
    return completedAt === undefined ? item : { ...item, completedAt: new Date(completedAt).toISOString() };
  }
  const starts = new Set((item.completedOccurrenceStarts ?? []).filter((value) => Number.isFinite(timestamp(value)))
    .map((value) => new Date(value).toISOString()));
  for (const ticket of completed) {
    const start = getScheduleTicketOccurrenceStart(item, ticket);
    if (start) starts.add(start);
  }
  return starts.size === 0 ? item : { ...item, completedOccurrenceStarts: [...starts].sort() };
}
