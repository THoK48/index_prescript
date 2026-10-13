import { getRoutineWindow, getScheduleOccurrences } from "./calendar.ts";
import { getFailureCooldownUntil, getInvalidDirectiveCooldownUntil } from "./ticketMachine.ts";
import type {
  IdealRoutine,
  LocalScheduleItem,
  PlannerCandidateDecision,
  PlannerDecisionDraft,
  Settings,
  Task,
  TaskDeadlineTier,
  Ticket,
  TicketCandidate,
  TicketSourceType,
} from "./ticketMachine.ts";

export interface PlannerContext {
  now: Date;
  tasks: Task[];
  localSchedule: LocalScheduleItem[];
  idealRoutines: IdealRoutine[];
  recentTickets: Ticket[];
  settings: Settings;
}

export interface PlannerPlan {
  candidate: TicketCandidate;
  decision: PlannerDecisionDraft;
}

export type DeadlineTier = TaskDeadlineTier;

interface PreparedCandidate {
  candidate: TicketCandidate;
  label: string;
  adjustmentReason?: string;
}

interface PreparedTaskCandidate extends PreparedCandidate {
  task: Task;
  deadlineTier: DeadlineTier;
  lastExecutedAt: number;
}

interface PreparedRoutineCandidate extends PreparedCandidate {
  routine: IdealRoutine;
}

interface ResolutionAdjustment<TCandidate extends PreparedCandidate> {
  candidate: TCandidate | null;
  reason: string;
}

const minuteMs = 60_000;
/** Shared whole-minute time policies used independently from priority selection. */
const availableWindowLimitMinutes = 120;
const transitionBufferMinutes = 5;
const minimumWorkMinutes = 5;
const maximumWorkMinutes = 30;

/** Ordered low-risk actions used when no registered Task, Routine, or Schedule can run. */
const systemFallbacks: readonly TicketCandidate[] = [
  { action: "주변을 5분간 정리할 것.", expectedMinutes: 5, sourceType: "SYSTEM", sourceId: "fallback:tidy" },
  { action: "물을 한 잔 마실 것.", expectedMinutes: 2, sourceType: "SYSTEM", sourceId: "fallback:water" },
  { action: "5분간 가볍게 걸을 것.", expectedMinutes: 5, sourceType: "SYSTEM", sourceId: "fallback:walk" },
  { action: "5분간 잠시 휴식할 것.", expectedMinutes: 5, sourceType: "SYSTEM", sourceId: "fallback:rest" },
  { action: "5분간 스트레칭할 것.", expectedMinutes: 5, sourceType: "SYSTEM", sourceId: "fallback:stretch" },
];

/** Reports whether two instants belong to the same local calendar date. */
function isSameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

/** Formats a local clock value for a human-readable Planner decision reason. */
function formatClock(value: Date): string {
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}

/** Compares IDs by code-point order so tie-breaking does not depend on device locale. */
function compareStableIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Orders selection timestamps, including never-selected negative infinity, without producing NaN. */
function compareSelectionTimes(left: number, right: number): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Appends the natural Korean object particle while preserving a neutral fallback for other scripts. */
function withObjectParticle(title: string): string {
  const lastCharacter = title.trim().at(-1);
  if (!lastCharacter) return title;
  const codePoint = lastCharacter.charCodeAt(0);
  if (codePoint < 0xac00 || codePoint > 0xd7a3) return `${title}을(를)`;
  return `${title}${(codePoint - 0xac00) % 28 === 0 ? "를" : "을"}`;
}

/** Returns whole usable minutes, capped at 120, reserving five minutes before the next fixed schedule. */
export function getAvailableWindow(now: Date, schedules: LocalScheduleItem[]): number {
  const rangeEnd = new Date(now.getTime() + 24 * 60 * minuteMs);
  const nextSchedule = getScheduleOccurrences(schedules, now, rangeEnd)
    .find((occurrence) => occurrence.startAt > now);
  if (!nextSchedule) return availableWindowLimitMinutes;
  const minutesUntilNextSchedule = Math.floor((nextSchedule.startAt.getTime() - now.getTime()) / minuteMs);
  return Math.max(0, Math.min(minutesUntilNextSchedule - transitionBufferMinutes, availableWindowLimitMinutes));
}

/** Preserves the previous public helper name while delegating all calculation to getAvailableWindow. */
export function getAvailableMinutes(now: Date, schedules: LocalScheduleItem[]): number {
  return getAvailableWindow(now, schedules);
}

/** Converts a Task deadline into one of six explicit urgency tiers. */
export function getDeadlineTier(task: Task, now: Date): DeadlineTier {
  if (!task.dueAt) return 5;
  const deadline = new Date(task.dueAt);
  if (Number.isNaN(deadline.getTime())) return 5;
  const hoursUntilDeadline = (deadline.getTime() - now.getTime()) / (60 * minuteMs);
  if (hoursUntilDeadline <= 0) return 0;
  if (hoursUntilDeadline <= 6) return 1;
  if (hoursUntilDeadline <= 24) return 2;
  if (hoursUntilDeadline <= 72) return 3;
  if (hoursUntilDeadline <= 168) return 4;
  return 5;
}

/** Describes one deadline tier without exposing internal numeric values. */
function getDeadlineTierLabel(task: Task, tier: DeadlineTier): string {
  if (tier === 0) return "마감 경과";
  if (tier === 1) return "6시간 이내 마감";
  if (tier === 2) return "24시간 이내 마감";
  if (tier === 3) return "3일 이내 마감";
  if (tier === 4) return "1주 이내 마감";
  return task.dueAt ? "1주 이후 마감" : "마감 없음";
}

/** Finds today's routine window, including a window that crossed midnight from yesterday. */
function resolveRoutineWindow(routine: IdealRoutine, now: Date): { startAt: Date; endAt: Date } | null {
  const today = getRoutineWindow(routine, now);
  if (today && today.startAt <= now && now < today.endAt) return today;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const previous = getRoutineWindow(routine, yesterday);
  return previous && previous.startAt <= now && now < previous.endAt ? previous : null;
}

/** Derives the latest selection time from issue history; never-selected Tasks sort first. */
function getTaskLastExecutedAt(taskId: string, tickets: Ticket[]): number {
  let latest = Number.NEGATIVE_INFINITY;
  for (const ticket of tickets) {
    if (ticket.sourceType !== "TASK" || ticket.sourceId !== taskId ||
        ticket.status === "CANCELLED") continue;
    const selectedAt = new Date(ticket.createdAt).getTime();
    if (!Number.isNaN(selectedAt)) latest = Math.max(latest, selectedAt);
  }
  return latest;
}

/** Prevents one routine occurrence from being issued again after it was resolved. */
function wasRoutineResolvedInWindow(
  routineId: string,
  window: { startAt: Date; endAt: Date },
  tickets: Ticket[],
): boolean {
  return tickets.some((ticket) => {
    if (ticket.sourceType !== "ROUTINE" || ticket.sourceId !== routineId ||
        (ticket.status !== "COMPLETED" && ticket.status !== "FAILED")) return false;
    const issuedAt = new Date(ticket.createdAt);
    return window.startAt <= issuedAt && issuedAt < window.endAt;
  });
}

/** Maps the previous environment-reset source to its equivalent current System source. */
function canonicalSourceId(sourceType: TicketSourceType, sourceId: string | undefined): string | undefined {
  return sourceType === "SYSTEM" && sourceId === "reset-environment" ? "fallback:tidy" : sourceId;
}

/** Orders terminal resolutions by their own event time without treating quality feedback as a failure. */
function compareTicketResolutions(left: Ticket, right: Ticket): number {
  const leftAt = new Date(left.invalidatedAt ?? left.completedAt ?? left.createdAt).getTime();
  const rightAt = new Date(right.invalidatedAt ?? right.completedAt ?? right.createdAt).getTime();
  return rightAt - leftAt || right.sequence - left.sequence || compareStableIds(left.id, right.id);
}

/** Finds the latest meaningful resolution, optionally scoped to one original source identity. */
function getLatestResolution(tickets: Ticket[], source?: Pick<TicketCandidate, "sourceType" | "sourceId">): Ticket | undefined {
  return tickets.filter((ticket) => (
    (ticket.status === "COMPLETED" || ticket.status === "FAILED" || ticket.status === "INVALID")
    && (!source || (ticket.sourceType === source.sourceType
      && canonicalSourceId(ticket.sourceType, ticket.sourceId) === canonicalSourceId(source.sourceType, source.sourceId)))
  )).sort(compareTicketResolutions)[0];
}

/** Blocks registered sources during feedback cooldown and the immediately rejected System source. */
function getInvalidSourceBlock(
  source: Pick<TicketCandidate, "sourceType" | "sourceId">,
  tickets: Ticket[],
  now: Date,
): string | null {
  const resolution = getLatestResolution(tickets, source);
  if (resolution?.status !== "INVALID") return null;
  if (source.sourceType === "SYSTEM") {
    return getLatestResolution(tickets)?.id === resolution.id ? "방금 이상 지령으로 기록한 동일 행동은 즉시 재발행하지 않음" : null;
  }
  const reportedAt = new Date(resolution.invalidatedAt ?? resolution.createdAt);
  const savedUntil = resolution.cooldownUntil ? new Date(resolution.cooldownUntil) : null;
  const until = savedUntil && Number.isFinite(savedUntil.getTime())
    ? savedUntil
    : getInvalidDirectiveCooldownUntil(source.sourceType, reportedAt);
  return until && until > now ? `${formatClock(until)}까지 이상 지령 피드백에 따라 재발행 보류` : null;
}

/** Applies quality suppression separately from execution-failure duration adjustments. */
function applyRecentResolution<TCandidate extends PreparedCandidate>(
  candidate: TCandidate,
  tickets: Ticket[],
  now: Date,
): ResolutionAdjustment<TCandidate> {
  const invalidBlock = getInvalidSourceBlock(candidate.candidate, tickets, now);
  if (invalidBlock) return { candidate: null, reason: invalidBlock };
  // 품질 피드백은 별도 보류에만 사용하고 기존 수행 실패의 조정 이력을 대신하지 않습니다.
  const lastResolution = getLatestResolution(tickets.filter((ticket) => ticket.status !== "INVALID"), candidate.candidate);
  if (!lastResolution || lastResolution.status !== "FAILED") {
    return { candidate, reason: candidate.candidate.selectionReason ?? "실행 가능" };
  }

  const failedAt = new Date(lastResolution.completedAt ?? lastResolution.createdAt);
  const savedCooldownUntil = lastResolution.cooldownUntil ? new Date(lastResolution.cooldownUntil) : null;
  const cooldownUntil = savedCooldownUntil && !Number.isNaN(savedCooldownUntil.getTime())
    ? savedCooldownUntil
    : getFailureCooldownUntil(lastResolution.failureReason ?? "other", failedAt);
  if (cooldownUntil && cooldownUntil > now) {
    return { candidate: null, reason: `${formatClock(cooldownUntil)}까지 실패 후 재발행 보류` };
  }
  if (!isSameLocalDay(failedAt, now)) {
    return { candidate, reason: candidate.candidate.selectionReason ?? "실행 가능" };
  }

  if (lastResolution.failureReason === "time_shortage" || lastResolution.failureReason === "too_difficult") {
    const expectedMinutes = Math.min(
      candidate.candidate.expectedMinutes,
      Math.max(minimumWorkMinutes, Math.floor(lastResolution.expectedMinutes / 2)),
    );
    const selectionReason = `${candidate.candidate.selectionReason ?? "실행 가능"} · 최근 실패 후 ${expectedMinutes}분으로 축소`;
    return {
      candidate: {
        ...candidate,
        adjustmentReason: `최근 실패 후 ${expectedMinutes}분으로 축소`,
        candidate: {
          ...candidate.candidate,
          action: candidate.candidate.action.replace(/\d+분간/, `${expectedMinutes}분간`),
          expectedMinutes,
          selectionReason,
        },
      },
      reason: selectionReason,
    };
  }
  return { candidate, reason: candidate.candidate.selectionReason ?? "실행 가능" };
}

/** Builds one Task candidate using only the shared available window for duration. */
function createTaskCandidate(
  task: Task,
  availableMinutes: number,
  now: Date,
  tickets: Ticket[],
): PreparedTaskCandidate | null {
  const remainingMinutes = task.estimatedMinutes === undefined
    ? 25
    : Math.max(0, task.estimatedMinutes - task.completedMinutes);
  const expectedMinutes = Math.min(remainingMinutes, maximumWorkMinutes, availableMinutes);
  if (task.status === "DONE" || expectedMinutes < minimumWorkMinutes) return null;
  const deadlineTier = getDeadlineTier(task, now);
  return {
    task,
    deadlineTier,
    lastExecutedAt: getTaskLastExecutedAt(task.id, tickets),
    label: task.title,
    candidate: {
      action: `${withObjectParticle(task.title)} ${expectedMinutes}분간 진행할 것.`,
      expectedMinutes,
      sourceType: "TASK",
      sourceId: task.id,
      selectionReason: `${deadlineTier <= 3 ? "긴급 할 일" : "일반 할 일"} · ${getDeadlineTierLabel(task, deadlineTier)} · 중요도 ${task.importance} · 가용 ${availableMinutes}분`,
      deadline: task.dueAt,
      trigger: "지금,",
    },
  };
}

/** Sorts Tasks by deadline tier, importance, oldest execution, and stable ID. */
function compareTaskCandidates(left: PreparedTaskCandidate, right: PreparedTaskCandidate): number {
  return left.deadlineTier - right.deadlineTier
    || right.task.importance - left.task.importance
    || compareSelectionTimes(left.lastExecutedAt, right.lastExecutedAt)
    || compareStableIds(left.task.id, right.task.id);
}

/** Builds a selected Task explanation from the documented within-tier ordering. */
function createSelectedTaskReason(candidate: PreparedTaskCandidate, sameLayer: PreparedTaskCandidate[]): string {
  const sameDeadline = sameLayer.filter((other) => other.deadlineTier === candidate.deadlineTier);
  const sameImportance = sameDeadline.filter((other) => other.task.importance === candidate.task.importance);
  const sameExecutionTime = sameImportance.filter((other) => other.lastExecutedAt === candidate.lastExecutedAt);
  const deadlineLabel = getDeadlineTierLabel(candidate.task, candidate.deadlineTier);
  let reason: string;
  if (sameLayer.length === 1) {
    reason = `${deadlineLabel} · 실행 가능한 ${candidate.deadlineTier <= 3 ? "긴급" : "일반"} 할 일이 하나라 선택됨`;
  } else if (sameDeadline.length === 1) {
    reason = `${deadlineLabel} · 마감 구간이 가장 가까워 선택됨`;
  } else if (sameImportance.length === 1) {
    reason = `${deadlineLabel} 할 일 중 중요도(${candidate.task.importance})가 가장 높아 선택됨`;
  } else if (sameExecutionTime.length === 1) {
    reason = `${deadlineLabel} · 중요도가 같은 할 일 중 가장 오래 선택되지 않아 선택됨`;
  } else {
    reason = `${deadlineLabel} · 중요도와 마지막 선택 시각이 같아 ID 순으로 선택됨`;
  }
  return candidate.adjustmentReason ? `${reason} · ${candidate.adjustmentReason}` : reason;
}

/** Converts an evaluated candidate into a compact persisted Planner audit item. */
function createCandidateDecision(
  sourceType: TicketSourceType,
  label: string,
  disposition: PlannerCandidateDecision["disposition"],
  reason: string,
  sourceId?: string,
  details: Pick<PlannerCandidateDecision, "priorityLayer" | "deadlineTier" | "importance" | "lastExecutedAt"> = {},
): PlannerCandidateDecision {
  return { sourceType, sourceId, label, score: null, disposition, reason, ...details };
}

/** Saves the exact Task sorting inputs alongside the candidate explanation without persisting duplicate Task state. */
function createTaskDecision(
  task: Task,
  disposition: PlannerCandidateDecision["disposition"],
  reason: string,
  now: Date,
  tickets: Ticket[],
): PlannerCandidateDecision {
  const deadlineTier = getDeadlineTier(task, now);
  const lastExecutedAt = getTaskLastExecutedAt(task.id, tickets);
  return createCandidateDecision("TASK", task.title, disposition, reason, task.id, {
    priorityLayer: deadlineTier <= 3 ? 3 : 5,
    deadlineTier,
    importance: task.importance,
    lastExecutedAt: Number.isFinite(lastExecutedAt) ? new Date(lastExecutedAt).toISOString() : null,
  });
}

/** Finalizes one deterministic Planner result while retaining useful candidate diagnostics. */
function createPlannerPlan(
  context: PlannerContext,
  candidate: TicketCandidate,
  availableMinutes: number,
  decisions: PlannerCandidateDecision[],
): PlannerPlan {
  const dispositionOrder = { SELECTED: 0, ELIGIBLE: 1, EXCLUDED: 2, SKIPPED: 3 } as const;
  const candidates = [...decisions]
    .sort((left, right) => dispositionOrder[left.disposition] - dispositionOrder[right.disposition]
      || (left.priorityLayer ?? 6) - (right.priorityLayer ?? 6)
      || (left.deadlineTier ?? 5) - (right.deadlineTier ?? 5)
      || (right.importance ?? 0) - (left.importance ?? 0)
      || compareSelectionTimes(
        left.lastExecutedAt ? new Date(left.lastExecutedAt).getTime() : Number.NEGATIVE_INFINITY,
        right.lastExecutedAt ? new Date(right.lastExecutedAt).getTime() : Number.NEGATIVE_INFINITY,
      )
      || compareStableIds(left.sourceId ?? left.label, right.sourceId ?? right.label))
    .slice(0, 20);
  return {
    candidate,
    decision: {
      evaluatedAt: context.now.toISOString(),
      availableMinutes,
      selectedAction: candidate.action,
      selectedReason: candidate.selectionReason ?? "Planner 계층 우선순위",
      candidates,
    },
  };
}

/** Marks remaining sources as intentionally skipped after a fixed schedule wins immediately. */
function appendPrioritySkippedDecisions(
  decisions: PlannerCandidateDecision[],
  tasks: Task[],
  routines: IdealRoutine[],
  reason: string,
  context: PlannerContext,
): void {
  for (const task of tasks) decisions.push(createTaskDecision(task, "SKIPPED", reason, context.now, context.recentTickets));
  for (const routine of routines) decisions.push(createCandidateDecision("ROUTINE", routine.title, "SKIPPED", reason, routine.id, { priorityLayer: 4 }));
}

/** Marks one candidate selected and optionally skips eligible candidates in lower tiers. */
function finalizeTierDecisions(
  decisions: PlannerCandidateDecision[],
  selected: TicketCandidate,
  reason: string,
  skippedSourceTypes: TicketSourceType[],
): void {
  for (const decision of decisions) {
    const isSelected = decision.disposition === "ELIGIBLE"
      && decision.sourceType === selected.sourceType
      && decision.sourceId === selected.sourceId;
    if (isSelected) {
      decision.disposition = "SELECTED";
      decision.reason = reason;
    } else if (decision.disposition === "ELIGIBLE" && skippedSourceTypes.includes(decision.sourceType)) {
      decision.disposition = "SKIPPED";
      decision.reason = `${reason} · 상위 계층 우선`;
    }
  }
}

/** Selects a fitting fallback deterministically, using passive waiting when the shared window is too short. */
function selectSystemFallback(tickets: Ticket[], availableMinutes: number, now: Date, decisions: PlannerCandidateDecision[]): TicketCandidate {
  if (availableMinutes < minimumWorkMinutes) {
    const waiting: TicketCandidate = {
      action: "다음 일정에 대비해 잠시 대기할 것.",
      expectedMinutes: Math.max(1, availableMinutes),
      sourceType: "SYSTEM",
      sourceId: "system:wait-for-schedule",
      selectionReason: "다음 일정 전 실행할 시간이 5분 미만이라 대기",
      trigger: "다음 일정이 가까우므로,",
    };
    const block = getInvalidSourceBlock(waiting, tickets, now);
    if (!block) return waiting;
    decisions.push(createCandidateDecision("SYSTEM", waiting.action, "EXCLUDED", block, waiting.sourceId, { priorityLayer: 6 }));
    return {
      action: "잠시 호흡을 고르며 대기할 것.",
      expectedMinutes: Math.max(1, availableMinutes),
      sourceType: "SYSTEM",
      sourceId: "system:regain-composure",
      selectionReason: "직전 대기 지령이 부적절하다고 기록되어 다른 대기 행동 선택",
      trigger: "다음 일정이 가까우므로,",
    };
  }
  const resolvedFallbackCount = tickets.filter((ticket) => (
    ticket.sourceType === "SYSTEM"
    && (ticket.sourceId === "reset-environment" || ticket.sourceId?.startsWith("fallback:"))
    && (ticket.status === "COMPLETED" || ticket.status === "FAILED" || ticket.status === "INVALID")
  )).length;
  let selected = systemFallbacks[resolvedFallbackCount % systemFallbacks.length];
  for (let offset = 0; offset < systemFallbacks.length; offset += 1) {
    const candidate = systemFallbacks[(resolvedFallbackCount + offset) % systemFallbacks.length];
    const block = getInvalidSourceBlock(candidate, tickets, now);
    if (!block) { selected = candidate; break; }
    decisions.push(createCandidateDecision("SYSTEM", candidate.action, "EXCLUDED", block, candidate.sourceId, { priorityLayer: 6 }));
  }
  return {
    ...selected,
    selectionReason: "현재 실행 가능한 등록 항목 없음",
    trigger: "지금 처리할 등록 항목이 없으므로,",
  };
}

/** Chooses one action through explicit priority tiers and returns its deterministic audit trail. */
export function planNextTicketWithDecision(context: PlannerContext): PlannerPlan {
  const { now, localSchedule, idealRoutines, recentTickets, tasks } = context;
  const decisions: PlannerCandidateDecision[] = [];
  const availableMinutes = getAvailableWindow(now, localSchedule);
  const dayBefore = new Date(now.getTime() - 24 * 60 * minuteMs);
  const dayAfter = new Date(now.getTime() + 24 * 60 * minuteMs);
  const occurrences = getScheduleOccurrences(localSchedule, dayBefore, dayAfter);

  const activeSchedule = occurrences.find((occurrence) => occurrence.startAt <= now && now < occurrence.endAt);
  if (activeSchedule) {
    const remaining = Math.max(1, Math.min(30, Math.ceil((activeSchedule.endAt.getTime() - now.getTime()) / minuteMs)));
    const prepared: PreparedCandidate = {
      label: activeSchedule.item.title,
      candidate: {
        action: `${activeSchedule.item.title} 일정에 집중할 것.`,
        expectedMinutes: remaining,
        sourceType: "SCHEDULE",
        sourceId: activeSchedule.item.id,
        selectionReason: "현재 진행 중인 고정 일정이 있어 선택됨",
        deadline: activeSchedule.endAt.toISOString(),
        trigger: "현재 일정이 진행 중이므로,",
      },
    };
    const adjusted = applyRecentResolution(prepared, recentTickets, now);
    if (adjusted.candidate) {
      decisions.push(createCandidateDecision("SCHEDULE", prepared.label, "SELECTED", adjusted.reason, prepared.candidate.sourceId, { priorityLayer: 1 }));
      appendPrioritySkippedDecisions(decisions, tasks, idealRoutines, "현재 진행 중인 고정 일정이 우선됨", context);
      return createPlannerPlan(context, adjusted.candidate.candidate, availableMinutes, decisions);
    }
    decisions.push(createCandidateDecision("SCHEDULE", prepared.label, "EXCLUDED", adjusted.reason, prepared.candidate.sourceId, { priorityLayer: 1 }));
  }

  const nextSchedule = occurrences.find((occurrence) => occurrence.startAt > now);
  if (nextSchedule) {
    const minutesUntil = Math.ceil((nextSchedule.startAt.getTime() - now.getTime()) / minuteMs);
    if (minutesUntil <= 15) {
      const prepared: PreparedCandidate = {
        label: nextSchedule.item.title,
        candidate: {
          action: `${nextSchedule.item.title} 일정을 준비할 것.`,
          expectedMinutes: Math.max(1, Math.min(10, minutesUntil)),
          sourceType: "SCHEDULE",
          sourceId: nextSchedule.item.id,
          selectionReason: "15분 안에 시작하는 고정 일정 준비가 필요하여 선택됨",
          deadline: nextSchedule.startAt.toISOString(),
          trigger: "곧 일정이 시작되므로,",
        },
      };
      const adjusted = applyRecentResolution(prepared, recentTickets, now);
      if (adjusted.candidate) {
        decisions.push(createCandidateDecision("SCHEDULE", prepared.label, "SELECTED", adjusted.reason, prepared.candidate.sourceId, { priorityLayer: 2 }));
        appendPrioritySkippedDecisions(decisions, tasks, idealRoutines, "15분 안에 시작하는 일정 준비가 우선됨", context);
        return createPlannerPlan(context, adjusted.candidate.candidate, availableMinutes, decisions);
      }
      decisions.push(createCandidateDecision("SCHEDULE", prepared.label, "EXCLUDED", adjusted.reason, prepared.candidate.sourceId, { priorityLayer: 2 }));
    }
  }

  const taskCandidates: PreparedTaskCandidate[] = [];
  for (const task of tasks) {
    const prepared = createTaskCandidate(task, availableMinutes, now, recentTickets);
    if (!prepared) {
      const reason = task.status === "DONE" ? "이미 완료된 Task" : "가용시간 또는 남은 시간이 5분 미만";
      decisions.push(createTaskDecision(task, "EXCLUDED", reason, now, recentTickets));
      continue;
    }
    const adjusted = applyRecentResolution(prepared, recentTickets, now);
    if (!adjusted.candidate) {
      decisions.push(createTaskDecision(task, "EXCLUDED", adjusted.reason, now, recentTickets));
      continue;
    }
    const candidate = adjusted.candidate;
    taskCandidates.push(candidate);
    decisions.push(createTaskDecision(task, "ELIGIBLE", adjusted.reason, now, recentTickets));
  }
  taskCandidates.sort(compareTaskCandidates);
  const urgentTasks = taskCandidates.filter((candidate) => candidate.deadlineTier <= 3);
  const normalTasks = taskCandidates.filter((candidate) => candidate.deadlineTier > 3);

  const routineCandidates: PreparedRoutineCandidate[] = [];
  for (const routine of idealRoutines) {
    const window = resolveRoutineWindow(routine, now);
    if (!window) {
      decisions.push(createCandidateDecision("ROUTINE", routine.title, "EXCLUDED", routine.enabled ? "현재 루틴 시간대가 아님" : "비활성화된 루틴", routine.id, { priorityLayer: 4 }));
      continue;
    }
    if (wasRoutineResolvedInWindow(routine.id, window, recentTickets)) {
      decisions.push(createCandidateDecision("ROUTINE", routine.title, "EXCLUDED", "현재 루틴 구간에서 이미 처리됨", routine.id, { priorityLayer: 4 }));
      continue;
    }
    const windowRemaining = Math.floor((window.endAt.getTime() - now.getTime()) / minuteMs);
    const expectedMinutes = Math.min(maximumWorkMinutes, windowRemaining, availableMinutes);
    if (expectedMinutes < minimumWorkMinutes) {
      decisions.push(createCandidateDecision("ROUTINE", routine.title, "EXCLUDED", "가용시간 또는 루틴에 남은 시간이 5분 미만", routine.id, { priorityLayer: 4 }));
      continue;
    }
    const prepared: PreparedRoutineCandidate = {
      routine,
      label: routine.title,
      candidate: {
        action: `${withObjectParticle(routine.title)} ${expectedMinutes}분간 수행할 것.`,
        expectedMinutes,
        sourceType: "ROUTINE",
        sourceId: routine.id,
        selectionReason: `현재 루틴 시간대 · 우선순위 ${routine.priority} · 가용 ${availableMinutes}분`,
        deadline: window.endAt.toISOString(),
        trigger: "지금은 이 루틴의 시간대이므로,",
      },
    };
    const adjusted = applyRecentResolution(prepared, recentTickets, now);
    if (!adjusted.candidate) {
      decisions.push(createCandidateDecision("ROUTINE", routine.title, "EXCLUDED", adjusted.reason, routine.id, { priorityLayer: 4 }));
      continue;
    }
    const candidate = adjusted.candidate;
    routineCandidates.push(candidate);
    decisions.push(createCandidateDecision("ROUTINE", routine.title, "ELIGIBLE", adjusted.reason, routine.id, { priorityLayer: 4 }));
  }
  routineCandidates.sort((left, right) => right.routine.priority - left.routine.priority
    || compareStableIds(left.routine.id, right.routine.id));

  const urgentTask = urgentTasks[0];
  if (urgentTask) {
    const reason = createSelectedTaskReason(urgentTask, urgentTasks);
    const selected = { ...urgentTask.candidate, selectionReason: reason };
    finalizeTierDecisions(decisions, selected, reason, ["ROUTINE"]);
    for (const normalTask of normalTasks) {
      const decision = decisions.find((item) => item.disposition === "ELIGIBLE" && item.sourceType === "TASK" && item.sourceId === normalTask.task.id);
      if (decision) {
        decision.disposition = "SKIPPED";
        decision.reason = `${reason} · 일반 Task보다 긴급 Task가 우선`;
      }
    }
    return createPlannerPlan(context, selected, availableMinutes, decisions);
  }

  const routine = routineCandidates[0];
  if (routine) {
    const baseReason = "현재 실행 가능한 루틴이 있으며 긴급 할 일이 없어 선택됨";
    const reason = routine.adjustmentReason ? `${baseReason} · ${routine.adjustmentReason}` : baseReason;
    const selected = { ...routine.candidate, selectionReason: reason };
    finalizeTierDecisions(decisions, selected, reason, ["TASK"]);
    return createPlannerPlan(context, selected, availableMinutes, decisions);
  }

  const normalTask = normalTasks[0];
  if (normalTask) {
    const reason = createSelectedTaskReason(normalTask, normalTasks);
    const selected = { ...normalTask.candidate, selectionReason: reason };
    finalizeTierDecisions(decisions, selected, reason, []);
    return createPlannerPlan(context, selected, availableMinutes, decisions);
  }

  const fallback = selectSystemFallback(recentTickets, availableMinutes, now, decisions);
  decisions.push(createCandidateDecision("SYSTEM", fallback.action, "SELECTED", fallback.selectionReason ?? "실행 가능한 등록 항목 없음", fallback.sourceId, { priorityLayer: 6 }));
  return createPlannerPlan(context, fallback, availableMinutes, decisions);
}

/** Chooses one deterministic current action while preserving the original Planner API. */
export function planNextTicket(context: PlannerContext): TicketCandidate {
  return planNextTicketWithDecision(context).candidate;
}
