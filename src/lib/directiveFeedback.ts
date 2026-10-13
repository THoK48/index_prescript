import type { InvalidDirectiveReason, Ticket } from "./ticketMachine.ts";

/** Shared Korean labels for quality feedback forms and historical reports, never execution-failure labels. */
export const invalidDirectiveReasonLabels: Record<InvalidDirectiveReason, string> = {
  TIME_IMPOSSIBLE: "시간상 수행 불가능",
  BAD_PRIORITY: "우선순위가 이상함",
  ALREADY_DONE: "이미 했거나 필요 없는 행동",
  CONTEXT_MISMATCH: "현재 상황과 맞지 않음",
  TOO_REPETITIVE: "같은 행동이 너무 자주 반복됨",
  OTHER: "기타",
};

/** Supplies stable reason order for both feedback selection and filtering historical cases. */
export const invalidDirectiveReasons: readonly InvalidDirectiveReason[] = [
  "TIME_IMPOSSIBLE", "BAD_PRIORITY", "ALREADY_DONE", "CONTEXT_MISMATCH", "TOO_REPETITIVE", "OTHER",
];

/** Returns only Planner-quality cases, newest first, without including user failures or normalization cancellations. */
export function getInvalidDirectiveHistory(tickets: Ticket[]): Ticket[] {
  return tickets.filter((ticket) => ticket.status === "INVALID")
    .sort((left, right) => new Date(right.invalidatedAt ?? right.createdAt).getTime()
      - new Date(left.invalidatedAt ?? left.createdAt).getTime()
      || right.sequence - left.sequence);
}
