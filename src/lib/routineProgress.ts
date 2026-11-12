import { getRoutineWindow } from "./calendar.ts";
import type { IdealRoutine, RoutineStep, Ticket } from "./ticketMachine.ts";

/** A concrete routine occurrence, independent of when the user eventually reports completion. */
export interface RoutineExecutionWindow {
  startAt: Date;
  endAt: Date;
}

/** Completed duration blocks and whole-action completion have deliberately different meanings. */
export interface RoutineStepProgress {
  targetMinutes: number;
  completedMinutes: number;
  remainingMinutes: number;
  isCompleted: boolean;
}

/** Recovers the originally issued occurrence, including legacy overnight Tickets and delayed reports. */
export function getRoutineTicketWindow(routine: IdealRoutine, ticket: Ticket): RoutineExecutionWindow | null {
  const issuedAt = new Date(ticket.createdAt);
  if (ticket.sourceType !== "ROUTINE" || ticket.sourceId !== routine.id || !Number.isFinite(issuedAt.getTime())) return null;
  const startAt = new Date(ticket.routineOccurrenceStartAt ?? "");
  const endAt = new Date(ticket.routineOccurrenceEndAt ?? "");
  if (Number.isFinite(startAt.getTime()) && Number.isFinite(endAt.getTime())
      && startAt <= issuedAt && issuedAt < endAt) return { startAt, endAt };
  const today = getRoutineWindow(routine, issuedAt);
  if (today && today.startAt <= issuedAt && issuedAt < today.endAt) return today;
  const yesterday = new Date(issuedAt);
  yesterday.setDate(yesterday.getDate() - 1);
  const previous = getRoutineWindow(routine, yesterday);
  return previous && previous.startAt <= issuedAt && issuedAt < previous.endAt ? previous : null;
}

/** Matches the original source, exact step and occurrence without using the completion date. */
function isCompletedBlockForStep(ticket: Ticket, routine: IdealRoutine, step: RoutineStep, window: RoutineExecutionWindow): boolean {
  if (ticket.status !== "COMPLETED" || ticket.sourceType !== "ROUTINE" || ticket.sourceId !== routine.id || ticket.routineStepId !== step.id) return false;
  const occurrenceStart = new Date(ticket.routineOccurrenceStartAt ?? "");
  if (Number.isFinite(occurrenceStart.getTime())) return occurrenceStart.getTime() === window.startAt.getTime();
  const issuedAt = new Date(ticket.createdAt);
  return window.startAt <= issuedAt && issuedAt < window.endAt;
}

/** Sums completed work for duration steps, but completes movement/completion steps after one explicit report. */
export function getRoutineStepProgress(routine: IdealRoutine, step: RoutineStep, window: RoutineExecutionWindow, tickets: Ticket[]): RoutineStepProgress {
  const completed = tickets.filter((ticket) => isCompletedBlockForStep(ticket, routine, step, window));
  const completedMinutes = completed.reduce((sum, ticket) => sum
    + (Number.isFinite(ticket.expectedMinutes) ? Math.max(0, ticket.expectedMinutes) : 0), 0);
  const isCompleted = step.actionType === "DURATION" ? completedMinutes >= step.expectedMinutes : completed.length > 0;
  return {
    targetMinutes: step.expectedMinutes,
    completedMinutes,
    remainingMinutes: isCompleted ? 0 : step.actionType === "DURATION" ? Math.max(0, step.expectedMinutes - completedMinutes) : step.expectedMinutes,
    isCompleted,
  };
}

/** Selects only the first unfinished step, preserving order while allowing several Tickets for one duration step. */
export function getCurrentRoutineStep(routine: IdealRoutine, window: RoutineExecutionWindow, tickets: Ticket[]): {
  step: RoutineStep; index: number; progress: RoutineStepProgress;
} | null {
  for (const [index, step] of (routine.steps ?? []).entries()) {
    const progress = getRoutineStepProgress(routine, step, window, tickets);
    if (!progress.isCompleted) return { step, index, progress };
  }
  return null;
}
