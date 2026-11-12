import { getTicketExpectedEndAt, isUnlimitedDurationTicket, type Ticket } from "./ticketMachine.ts";

/** Derives a stable seven-through-fifteen-minute start prompt from the existing random Ticket identity. */
function getFallbackStartMinutes(ticketId: string): number {
  let hash = 0;
  for (let index = 0; index < ticketId.length; index += 1) hash = (hash * 31 + ticketId.charCodeAt(index)) | 0;
  return (Math.abs(hash) % 9) + 7;
}

/** Identifies an original Task deadline that was already due when this execution block was issued. */
export function getOverdueTaskDeadline(ticket: Ticket): Date | null {
  if (ticket.sourceType !== "TASK" || !ticket.deadline) return null;
  const deadline = new Date(ticket.deadline);
  const issuedAt = new Date(ticket.createdAt);
  return Number.isFinite(deadline.getTime()) && Number.isFinite(issuedAt.getTime()) && deadline <= issuedAt ? deadline : null;
}

/** Separates original overdue work from the fixed execution-end instant without moving an old ACTIVE forward. */
export function getDirectiveDisplayDeadline(ticket: Ticket): Date | null {
  if (!ticket.deadline) return null;
  const deadline = getOverdueTaskDeadline(ticket) ? getTicketExpectedEndAt(ticket) : new Date(ticket.deadline);
  return Number.isFinite(deadline.getTime()) ? deadline : null;
}

/** Formats the existing timing line while preventing an overdue Task date from becoming a new instruction deadline. */
export function formatDirectiveTiming(ticket: Ticket): string {
  if (isUnlimitedDurationTicket(ticket)) return "";
  if (ticket.sourceType === "SYSTEM" &&
      (ticket.sourceId === "system:wait-for-schedule" || ticket.sourceId === "system:regain-composure")) {
    return `${ticket.expectedMinutes}분 동안`;
  }
  const deadline = getDirectiveDisplayDeadline(ticket);
  if (!deadline) return `${getFallbackStartMinutes(ticket.id)}분 이내에`;
  return `${new Intl.DateTimeFormat("ko-KR", {
    month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: false,
  }).format(deadline)}까지`;
}
