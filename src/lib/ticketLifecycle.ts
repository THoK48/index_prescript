import { planNextTicketWithDecision } from "./planner.ts";
import {
  completeTicket,
  failTicket,
  invalidateTicket,
  issueTicket,
  type AppState,
  type FailureReason,
  type InvalidDirectiveReason,
  type TransitionResult,
} from "./ticketMachine.ts";

export type TicketResolution =
  | { kind: "complete" }
  | { kind: "fail"; reason: FailureReason }
  | { kind: "invalid"; reason: InvalidDirectiveReason };

/** Resolves the active ticket, replans, and issues its replacement as one persisted transition. */
export function resolveAndReissueTicket(
  state: AppState,
  ticketId: string,
  resolution: TicketResolution,
  now: Date,
  nextTicketId: string,
): TransitionResult {
  const resolved = resolution.kind === "complete"
    ? completeTicket(state, ticketId, now)
    : resolution.kind === "invalid"
      ? invalidateTicket(state, ticketId, resolution.reason, now)
      : failTicket(state, ticketId, resolution.reason, now);
  if (resolved.kind === "conflict") return resolved;

  const plan = planNextTicketWithDecision({
    now,
    tasks: resolved.state.tasks,
    localSchedule: resolved.state.localScheduleItems,
    idealRoutines: resolved.state.idealRoutines,
    recentTickets: resolved.state.tickets,
    settings: resolved.state.settings,
  });
  return issueTicket(resolved.state, plan.candidate, now, nextTicketId, plan.decision);
}
