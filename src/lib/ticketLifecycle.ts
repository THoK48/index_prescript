import { planNextTicketWithDecision } from "./planner.ts";
import {
  completeTicket,
  cancelTicketForContext,
  failTicket,
  invalidateTicket,
  issueTicket,
  getActiveTicket,
  type AppState,
  type FailureReason,
  type InvalidDirectiveReason,
  type TransitionResult,
} from "./ticketMachine.ts";
import { getActiveContextConflict, resolveEffectiveContext, type UserContext } from "./userContext.ts";

export type TicketResolution =
  | { kind: "complete" }
  | { kind: "fail"; reason: FailureReason }
  | { kind: "invalid"; reason: InvalidDirectiveReason };

/** Plans only when idle, atomically persisting either a real directive or a normal deferral snapshot. */
export function planAndIssueTicket(state: AppState, now: Date, ticketId: string): TransitionResult {
  if (getActiveTicket(state)) return { kind: "conflict", state };
  const current = { ...state, userContext: resolveEffectiveContext(state.userContext, now) };
  const plan = planNextTicketWithDecision({
    now, tasks: current.tasks, localSchedule: current.localScheduleItems, idealRoutines: current.idealRoutines,
    recentTickets: current.tickets, settings: current.settings, userContext: current.userContext,
  });
  if (plan.kind === "DEFERRED") {
    const previous = current.plannerDecisions[0];
    const isRepeated = previous?.result === "DEFERRED" && previous.selectedReason === plan.reason
      && JSON.stringify(previous.userContext) === JSON.stringify(plan.decision.userContext)
      && JSON.stringify(previous.candidates) === JSON.stringify(plan.decision.candidates);
    return {
      kind: "success", state: { ...current,
        plannerDeferral: { reason: plan.reason, resumeAt: plan.resumeAt, decision: plan.decision },
        plannerDecisions: isRepeated ? current.plannerDecisions : [plan.decision, ...current.plannerDecisions].slice(0, 50),
      },
    };
  }
  return issueTicket(current, plan.candidate, now, ticketId, plan.decision);
}

/** Saves a context without resolving ACTIVE; idle states can safely produce a directive or defer. */
export function saveUserContextState(state: AppState, context: UserContext, now: Date, ticketId: string): TransitionResult {
  const current = { ...state, userContext: resolveEffectiveContext(context, now) };
  return getActiveTicket(current) ? { kind: "success", state: current } : planAndIssueTicket(current, now, ticketId);
}

/** Confirms cancellation against the latest ACTIVE identity and context, never a replacement from another tab. */
export function replanForUserContext(state: AppState, ticketId: string, now: Date, nextTicketId: string): TransitionResult {
  const active = getActiveTicket(state);
  if (!active || active.id !== ticketId || !getActiveContextConflict(state, active, now)) return { kind: "conflict", state };
  const cancelled = cancelTicketForContext(state, ticketId, now);
  return cancelled.kind === "success" ? planAndIssueTicket(cancelled.state, now, nextTicketId) : cancelled;
}

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

  return planAndIssueTicket(resolved.state, now, nextTicketId);
}
