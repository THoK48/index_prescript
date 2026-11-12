import { appendObjectParticle } from "./koreanParticle.ts";
import type { IdealRoutine, RoutineActionType } from "./ticketMachine.ts";

/** Removes terminal punctuation before a directive receives its single canonical period. */
function stripTerminalPunctuation(value: string): string {
  return value.trim().replace(/[.!?。]+$/u, "").trim();
}

/** Turns a short action label or an already-written command into a Korean command clause. */
function createCommandClause(value: string): string {
  const action = stripTerminalPunctuation(value);
  if (!action) return "현재 행동을 수행할 것";
  if (/(?:할|할\s*수\s*있을|을|를)\s*것$/u.test(action)) return action;
  if (action.endsWith("하다")) return `${action.slice(0, -2)}할 것`;
  if (action.endsWith("하기")) return `${action.slice(0, -2)}할 것`;
  return `${action}할 것`;
}

/** Creates a duration, completion, or movement command without exposing Planner metadata. */
export function createDirectiveAction(
  title: string,
  actionType: RoutineActionType,
  expectedMinutes: number,
): string {
  const action = stripTerminalPunctuation(title);
  if (actionType === "MOVEMENT") {
    const movementClause = /(?:할|을|를)\s*것$/u.test(action)
      ? action
      : `${appendObjectParticle(action)} 시작할 것`;
    return `지금 ${movementClause}.`;
  }
  const commandClause = createCommandClause(action);
  return actionType === "DURATION"
    ? `${expectedMinutes}분 동안 ${commandClause}.`
    : `${commandClause}.`;
}

/** Infers a conservative action style for legacy routines that do not have explicit detailed steps. */
export function inferRoutineActionType(routine: Pick<IdealRoutine, "title" | "category">): RoutineActionType {
  if (/(귀가|이동|출발|등교|하교|출근길|퇴근길)/u.test(routine.title)) return "MOVEMENT";
  if (/(출근|퇴근|기상|취침|샤워)/u.test(routine.title) || routine.category === "sleep") return "COMPLETION";
  return "DURATION";
}

