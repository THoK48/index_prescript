import assert from "node:assert/strict";
import test from "node:test";
import { createDecryptionFrame } from "../src/lib/decryption.ts";
import {
  coordinateTicketSignal,
  createTicketPrintPlan,
  createTicketSignalPlan,
  ticketSignalAssetPath,
  ticketWaitLoopAssetPath,
} from "../src/lib/ticketSignal.ts";
import {
  completeTicket,
  createInitialState,
  failTicket,
  getActiveTicket,
  getActiveTicketStaleness,
  issueTicket,
  invalidateTicket,
  normalizeState,
} from "../src/lib/ticketMachine.ts";
import { createStateBackup, migrateV1State, parseStateBackup } from "../src/lib/stateMigration.ts";
import {
  createIdealRoutine,
  createLocalScheduleItem,
  getRoutineWindow,
  scheduleOccursOnDate,
} from "../src/lib/calendar.ts";
import {
  getAvailableMinutes,
  getAvailableWindow,
  getDeadlineTier,
  planNextTicket,
  planNextTicketWithDecision,
  type PlannerContext,
} from "../src/lib/planner.ts";
import { resolveAndReissueTicket } from "../src/lib/ticketLifecycle.ts";
import { getInvalidDirectiveHistory } from "../src/lib/directiveFeedback.ts";
import {
  advanceNavigationRevealSequence,
  createNavigationRevealSequence,
  navigationIdleMs,
} from "../src/lib/navigationVisibility.ts";
import type { AppState, Task, Ticket, TicketCandidate } from "../src/lib/ticketMachine.ts";
import {
  createAndroidNotificationChannel,
  getNotificationSoundOptions,
  notificationChannelId,
  notificationSoundFile,
} from "../src/lib/notificationSound.ts";

import {
  createCalendarWidgetDays,
  createCalendarWidgetUrl,
  getCalendarWidgetDateKey,
  parseCalendarWidgetDate,
  parseCalendarWidgetLaunch,
  parseCalendarWidgetQuery,
} from "../src/lib/calendarWidget.ts";

/** Keeps the custom audio on both Android channel-based and per-notification delivery paths. */
test("uses the supplied notification audio on Android without reusing the old channel", () => {
  const channel = createAndroidNotificationChannel();
  assert.equal(notificationSoundFile, "directive_alert.wav");
  assert.match(notificationSoundFile, /^[a-z][a-z0-9_]*\.wav$/);
  assert.notEqual(notificationChannelId, "directive-alerts");
  assert.equal(channel.id, notificationChannelId);
  assert.equal(channel.sound, notificationSoundFile);
  assert.equal(channel.importance, 4);
  assert.deepEqual(getNotificationSoundOptions("android"), { sound: notificationSoundFile });
  assert.deepEqual(getNotificationSoundOptions("ios"), { sound: notificationSoundFile });
  assert.deepEqual(getNotificationSoundOptions("web"), {});
});

/** Covers leap days, month boundaries and impossible dates without accepting Date rollover. */
test("validates calendar widget local dates", () => {
  for (const key of ["2024-02-29", "2026-12-31", "2027-01-01"]) {
    const date = parseCalendarWidgetDate(key);
    assert.ok(date);
    assert.equal(getCalendarWidgetDateKey(date), key);
  }
  for (const key of ["2026-02-29", "2026-02-30", "2026-13-01", "2026-10-00", "2026-1-1", "not-a-date"]) {
    assert.equal(parseCalendarWidgetDate(key), null);
  }
});

/** Ensures the widget cache is a minimal, stable, unfinished-task projection with local dates. */
test("projects unfinished dated tasks into calendar widget counts", () => {
  const base: Task = { id: "one", title: "private title", category: "personal", importance: 3, completedMinutes: 0, status: "TODO" };
  const firstDate = new Date(2026, 9, 13, 0, 30).toISOString();
  const nextDate = new Date(2026, 9, 14, 23, 30).toISOString();
  const tasks: Task[] = [
    { ...base, dueAt: firstDate },
    { ...base, id: "two", dueAt: firstDate, status: "DOING" },
    { ...base, id: "done", dueAt: firstDate, status: "DONE" },
    { ...base, id: "next", dueAt: nextDate },
    { ...base, id: "undated" },
    { ...base, id: "invalid", dueAt: "invalid" },
  ];
  const snapshot = JSON.stringify(tasks);
  assert.deepEqual(createCalendarWidgetDays(tasks), [
    { dateKey: "2026-10-13", count: 2 },
    { dateKey: "2026-10-14", count: 1 },
  ]);
  assert.deepEqual(createCalendarWidgetDays([...tasks].reverse()), createCalendarWidgetDays(tasks));
  assert.equal(JSON.stringify(tasks), snapshot);
  assert.deepEqual(createCalendarWidgetDays([]), []);
});

/** Restricts widget navigation to valid internal editor requests and distinct repeated tap IDs. */
test("routes calendar widget taps to the date-specific editor", () => {
  const request = { dateKey: "2026-10-13", requestId: "first-tap" };
  assert.deepEqual(parseCalendarWidgetLaunch(request), request);
  const url = createCalendarWidgetUrl(request);
  assert.ok(url.startsWith("/tasks/?"));
  assert.deepEqual(parseCalendarWidgetQuery(url.slice(url.indexOf("?"))), request);
  assert.notEqual(url, createCalendarWidgetUrl({ ...request, requestId: "second-tap" }));
  assert.equal(parseCalendarWidgetLaunch({ ...request, dateKey: "2026-02-30" }), null);
  assert.equal(parseCalendarWidgetLaunch({ ...request, requestId: "https://external.example" }), null);
  assert.equal(parseCalendarWidgetLaunch({ ...request, requestId: "" }), null);
  assert.equal(parseCalendarWidgetLaunch(null), null);
  assert.equal(parseCalendarWidgetQuery("?widgetDate=2026-10-13&widgetRequestId=first-tap"), null);
  assert.equal(parseCalendarWidgetQuery(""), null);
});

const now = new Date("2026-10-06T09:00:00.000Z");

/** Verifies that only three timely clicks reveal navigation and a late click starts over. */
test("reveals navigation after three timely background clicks", () => {
  let sequence = createNavigationRevealSequence();
  const first = advanceNavigationRevealSequence(sequence, 1_000);
  sequence = first.sequence;
  const second = advanceNavigationRevealSequence(sequence, 1_500);
  sequence = second.sequence;
  const third = advanceNavigationRevealSequence(sequence, 2_000);

  assert.equal(first.shouldReveal, false);
  assert.equal(second.shouldReveal, false);
  assert.equal(third.shouldReveal, true);
  assert.deepEqual(third.sequence, createNavigationRevealSequence());

  const expired = advanceNavigationRevealSequence(second.sequence, 5_000);
  assert.equal(expired.shouldReveal, false);
  assert.equal(expired.sequence.clickCount, 1);
  assert.equal(navigationIdleMs, 5_000);
});

/** Verifies that decryption frames preserve revealed text, spacing, and punctuation. */
test("creates an accessible progressive decryption frame", () => {
  assert.equal(createDecryptionFrame("자료 구조.", 2, () => 0), "자료 00.");
  assert.equal(createDecryptionFrame("자료 구조.", 99, () => 0), "자료 구조.");
});

/** Verifies that a ticket is preceded by exactly three short, ordered beeps. */
test("creates a three-beep ticket signal", () => {
  assert.equal(ticketSignalAssetPath, "/audio/limbus-beep.wav");
  assert.equal(ticketWaitLoopAssetPath, "/audio/limbus-beep-wait-loop.wav");
  const signalPlan = createTicketSignalPlan();
  assert.equal(signalPlan.length, 3);
  assert.ok(signalPlan.every((tone) => tone.frequencyHz === 880 && tone.endFrequencyHz === 440));
  assert.ok(signalPlan.every((tone) => tone.durationSeconds === 0.2 && tone.waveform === "square" && tone.peakGain === 0.085));
  assert.equal(signalPlan[1].startOffsetSeconds - (signalPlan[0].startOffsetSeconds + signalPlan[0].durationSeconds), 0.7);
  assert.equal(signalPlan[2].startOffsetSeconds - (signalPlan[1].startOffsetSeconds + signalPlan[1].durationSeconds), 0.7);
});

/** Verifies that a fast issue never starts the delayed-issuance loop. */
test("skips the wait loop when ticket issuance settles during the opening sound", async () => {
  const events: string[] = [];
  await coordinateTicketSignal(
    Promise.resolve(),
    async () => { events.push("opening"); },
    async () => { events.push("loop"); },
  );
  assert.deepEqual(events, ["opening"]);
});

/** Verifies that a delayed issue loops until its transition settles. */
test("loops the wait clip until delayed ticket issuance settles", async () => {
  const events: string[] = [];
  let settleIssue: (() => void) | undefined;
  const delayedIssue = new Promise<void>((resolve) => { settleIssue = resolve; });
  const playback = coordinateTicketSignal(
    delayedIssue,
    async () => { events.push("opening"); },
    async (untilSettled) => {
      events.push("loop-start");
      await untilSettled;
      events.push("loop-stop");
    },
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ["opening", "loop-start"]);
  settleIssue?.();
  await playback;
  assert.deepEqual(events, ["opening", "loop-start", "loop-stop"]);
});

/** Verifies that the printer effect has evenly spaced paper-feed pulses. */
test("creates a ticket printer sound plan", () => {
  const printPlan = createTicketPrintPlan();
  assert.equal(printPlan.durationSeconds, 0.9);
  assert.equal(printPlan.pulseOffsetsSeconds.length, 11);
  assert.ok(printPlan.pulseOffsetsSeconds.every((offset, index, offsets) =>
    index === 0 || Math.abs(offset - offsets[index - 1] - 0.075) < Number.EPSILON * 4));
});

/** Creates a minimal valid candidate for state-machine-only tests. */
function createCandidate(): TicketCandidate {
  return { action: "책상을 10분간 정리할 것.", expectedMinutes: 10, sourceType: "SYSTEM", sourceId: "test-action" };
}

/** Verifies that an active ticket blocks another issue request. */
test("issues only one active ticket", () => {
  const initial = createInitialState();
  const first = issueTicket(initial, createCandidate(), now, "first");
  assert.equal(first.kind, "success");
  const second = issueTicket(first.state, createCandidate(), now, "second");
  assert.equal(second.kind, "conflict");
  assert.equal(second.state.tickets.length, 1);
  assert.equal(getActiveTicket(second.state)?.id, "first");
});

/** Verifies that completion records time and enables a later issue request. */
test("completion unlocks the next ticket", () => {
  const initial = createInitialState();
  const first = issueTicket(initial, createCandidate(), now, "first");
  const completed = completeTicket(first.state, "first", now);
  assert.equal(completed.kind, "success");
  assert.equal(completed.state.tickets[0].status, "COMPLETED");
  assert.equal(completed.state.tickets[0].completedAt, now.toISOString());
  assert.equal(getActiveTicket(completed.state), null);
  const second = issueTicket(completed.state, createCandidate(), now, "second");
  assert.equal(second.kind, "success");
  assert.equal(getActiveTicket(second.state)?.sequence, 2);
});

/** Verifies that failure records a reason and enables a later issue request. */
test("failure records a reason and unlocks the next ticket", () => {
  const initial = createInitialState();
  const first = issueTicket(initial, createCandidate(), now, "first");
  const failed = failTicket(first.state, "first", "schedule_changed", now);
  assert.equal(failed.kind, "success");
  assert.equal(failed.state.tickets[0].failureReason, "schedule_changed");
  assert.equal(failed.state.tickets[0].status, "FAILED");
  assert.equal(issueTicket(failed.state, createCandidate(), now, "second").kind, "success");
});

/** Verifies that completion and replacement issuance finish with exactly one active ticket. */
test("completion atomically reissues one next ticket", () => {
  const first = issueTicket(createInitialState(), createCandidate(), now, "first");
  const reissued = resolveAndReissueTicket(first.state, "first", { kind: "complete" }, now, "second");
  assert.equal(reissued.kind, "success");
  assert.equal(reissued.state.tickets.find((ticket) => ticket.id === "first")?.status, "COMPLETED");
  assert.equal(getActiveTicket(reissued.state)?.id, "second");
  assert.equal(reissued.state.tickets.filter((ticket) => ticket.status === "ACTIVE").length, 1);
});

/** Verifies that failure is recorded before the Planner creates a single replacement ticket. */
test("failure atomically replans and reissues one next ticket", () => {
  const first = issueTicket(createInitialState(), createCandidate(), now, "first");
  const reissued = resolveAndReissueTicket(
    first.state,
    "first",
    { kind: "fail", reason: "physical_condition" },
    now,
    "second",
  );
  assert.equal(reissued.kind, "success");
  const failed = reissued.state.tickets.find((ticket) => ticket.id === "first");
  assert.equal(failed?.status, "FAILED");
  assert.equal(failed?.failureReason, "physical_condition");
  assert.equal(getActiveTicket(reissued.state)?.id, "second");
  assert.equal(reissued.state.tickets.filter((ticket) => ticket.status === "ACTIVE").length, 1);
});

/** Verifies that stale requests and inconsistent saved state cannot create two active tickets. */
test("stale completion and duplicate saved tickets preserve the one-active rule", () => {
  const initial = createInitialState();
  const first = issueTicket(initial, createCandidate(), now, "first");
  assert.equal(completeTicket(first.state, "unknown", now).kind, "conflict");
  const duplicated = { ...first.state, tickets: [first.state.tickets[0], { ...first.state.tickets[0], id: "duplicate" }] };
  const normalized = normalizeState(duplicated);
  assert.equal(normalized.tickets.filter((ticket) => ticket.status === "ACTIVE").length, 1);
  assert.equal(normalized.tickets[1].status, "CANCELLED");
});

/** Verifies that the v0.1 key's data is converted without losing user records. */
test("migrates directives, schedules, settings, and completed/failed history", () => {
  const legacy = {
    directives: [
      { id: "one", sequence: 1, recipient: "태호", action: "정리할 것.", trigger: "지금,", expectedMinutes: 10, status: "COMPLETED", createdAt: now.toISOString(), completedAt: now.toISOString() },
      { id: "two", sequence: 2, recipient: "태호", action: "쉴 것.", trigger: "지금,", expectedMinutes: 10, status: "FAILED", createdAt: now.toISOString(), completedAt: now.toISOString(), failureReason: "time_shortage" },
    ],
    tasks: [{ id: "task", title: "과제", importance: 4, status: "TODO", category: "study", estimatedMinutes: 40 }],
    scheduleItems: [{ id: "event", title: "약속", startAt: now.toISOString(), endAt: new Date(now.getTime() + 3_600_000).toISOString(), type: "appointment" }],
    settings: { userName: "태호", preferredBedtime: "00:30", preferredWakeTime: "08:00", tone: "formal" },
  };
  const migrated = migrateV1State(legacy);
  assert.ok(migrated);
  assert.deepEqual(migrated.tickets.map((ticket) => ticket.status), ["COMPLETED", "FAILED"]);
  assert.equal(migrated.tickets[1].failureReason, "time_shortage");
  assert.equal(migrated.localScheduleItems[0].title, "약속");
  assert.equal(migrated.tasks[0].completedMinutes, 0);
  assert.equal(migrated.settings.userName, "태호");
  assert.equal(migrated.settings.preferredBedtime, "00:30");
});

/** Verifies that a portable backup round-trip preserves the complete current state. */
test("creates and restores a versioned state backup", () => {
  const state = {
    ...createInitialState(),
    tasks: [{
      id: "backup-task", title: "백업할 일", completedMinutes: 10, importance: 4 as const,
      status: "DOING" as const, category: "personal" as const, estimatedMinutes: 30,
    }],
  };
  const backup = createStateBackup(state, now);
  const restored = parseStateBackup(JSON.parse(JSON.stringify(backup)) as unknown);
  assert.deepEqual(restored, state);
});

/** Verifies that unrelated JSON cannot replace current application state. */
test("rejects an unrelated backup payload", () => {
  assert.equal(parseStateBackup({ format: "other", version: 1, state: {} }), null);
});

/** Verifies that non-recurring schedules are valid only on their original date. */
test("creates a non-recurring schedule", () => {
  const startAt = new Date(2026, 9, 6, 19, 0);
  const endAt = new Date(2026, 9, 6, 20, 0);
  const result = createLocalScheduleItem({
    title: "약속", startAt: startAt.toISOString(), endAt: endAt.toISOString(),
    type: "appointment", recurrence: { frequency: "NONE" },
  }, "schedule");
  assert.equal(result.kind, "success");
  if (result.kind !== "success") return;
  assert.equal(scheduleOccursOnDate(result.value, new Date(2026, 9, 6)), true);
  assert.equal(scheduleOccursOnDate(result.value, new Date(2026, 9, 7)), false);
});

/** Verifies that daily recurrence begins on the saved schedule date. */
test("creates a daily recurring schedule", () => {
  const startAt = new Date(2026, 9, 6, 7, 30);
  const endAt = new Date(2026, 9, 6, 8, 0);
  const result = createLocalScheduleItem({
    title: "아침 준비", startAt: startAt.toISOString(), endAt: endAt.toISOString(),
    type: "other", recurrence: { frequency: "DAILY" },
  }, "daily");
  assert.equal(result.kind, "success");
  if (result.kind !== "success") return;
  assert.equal(scheduleOccursOnDate(result.value, new Date(2026, 9, 7)), true);
  assert.equal(scheduleOccursOnDate(result.value, new Date(2026, 9, 5)), false);
});

/** Verifies selected weekdays and rejects a weekly rule without weekdays. */
test("creates a selected-weekday schedule and rejects an empty weekly rule", () => {
  const startAt = new Date(2026, 9, 5, 20, 0);
  const endAt = new Date(2026, 9, 5, 21, 0);
  const valid = createLocalScheduleItem({
    title: "운동", startAt: startAt.toISOString(), endAt: endAt.toISOString(),
    type: "exercise", recurrence: { frequency: "WEEKLY", daysOfWeek: [1, 3, 5, 3] },
  }, "weekly");
  assert.equal(valid.kind, "success");
  if (valid.kind === "success") {
    assert.deepEqual(valid.value.recurrence?.daysOfWeek, [1, 3, 5]);
    assert.equal(scheduleOccursOnDate(valid.value, new Date(2026, 9, 7)), true);
    assert.equal(scheduleOccursOnDate(valid.value, new Date(2026, 9, 8)), false);
  }
  const invalid = createLocalScheduleItem({
    title: "운동", startAt: startAt.toISOString(), endAt: endAt.toISOString(),
    type: "exercise", recurrence: { frequency: "WEEKLY", daysOfWeek: [] },
  }, "invalid-weekly");
  assert.equal(invalid.kind, "invalid");
});

/** Verifies invalid time ranges are rejected before local state is mutated. */
test("rejects an invalid schedule time range", () => {
  const startAt = new Date(2026, 9, 6, 20, 0).toISOString();
  const result = createLocalScheduleItem({
    title: "잘못된 일정", startAt, endAt: startAt,
    type: "other", recurrence: { frequency: "NONE" },
  }, "invalid");
  assert.equal(result.kind, "invalid");
});

/** Verifies that an enabled ideal routine resolves only on selected weekdays. */
test("creates a weekday ideal routine", () => {
  const result = createIdealRoutine({
    title: "공부", startTime: "22:00", endTime: "23:30", daysOfWeek: [1, 2, 3, 4, 5],
    category: "study", priority: 4, enabled: true,
  }, "routine");
  assert.equal(result.kind, "success");
  if (result.kind !== "success") return;
  assert.ok(getRoutineWindow(result.value, new Date(2026, 9, 6)));
  assert.equal(getRoutineWindow(result.value, new Date(2026, 9, 11)), null);
});

/** Creates a deterministic Task fixture for Planner tests. */
function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task", title: "자료구조 과제", estimatedMinutes: 120, completedMinutes: 0,
    importance: 3, status: "TODO", category: "study", ...overrides,
  };
}

/** Issues a source-linked Task ticket for progress and failure fixtures. */
function createTaskTicket(status: Ticket["status"], overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "ticket", sequence: 1, recipient: "사용자", deadline: null, trigger: "지금,",
    action: "자료구조 과제를 30분간 진행할 것.", expectedMinutes: 30,
    sourceType: "TASK", sourceId: "task", status, createdAt: now.toISOString(), ...overrides,
  };
}

/** Creates an isolated local-time Planner context for policy boundary and ordering tests. */
function createPlannerContext(overrides: Partial<PlannerContext> = {}): PlannerContext {
  return {
    now: new Date(2026, 9, 6, 10, 0),
    tasks: [],
    localSchedule: [],
    idealRoutines: [],
    recentTickets: [],
    settings: createInitialState().settings,
    ...overrides,
  };
}

/** Ensures invalid feedback never advances Task progress or changes execution-result totals. */
test("invalid feedback is separate from user completion and failure", () => {
  const task = createTask({ completedMinutes: 10 });
  const active = createTaskTicket("ACTIVE");
  const state = { ...createInitialState(), tasks: [task], tickets: [active] };
  const result = invalidateTicket(state, active.id, "TIME_IMPOSSIBLE", now);
  assert.equal(result.kind, "success");
  assert.equal(result.state.tasks[0].completedMinutes, 10);
  assert.equal(result.state.tasks[0].status, "TODO");
  assert.equal(result.state.tickets[0].status, "INVALID");
  assert.equal(result.state.tickets[0].invalidReason, "TIME_IMPOSSIBLE");
  assert.equal(result.state.tickets[0].invalidatedAt, now.toISOString());
  assert.equal(result.state.tickets[0].failureReason, undefined);
  assert.equal(result.state.tickets[0].completedAt, undefined);
  assert.equal(result.state.tickets.filter((ticket) => ticket.status === "FAILED").length, 0);
  assert.equal(state.tickets[0].status, "ACTIVE");
});

/** Reports only the requested active identity and atomically selects a different original Task, even with the same title. */
test("invalid feedback and replacement preserve the one-active invariant", () => {
  const context = createPlannerContext({ tasks: [
    createTask({ id: "first", title: "동일 제목", importance: 5 }),
    createTask({ id: "second", title: "동일 제목", importance: 1 }),
  ] });
  const plan = planNextTicketWithDecision(context);
  const state = { ...createInitialState(), tasks: context.tasks };
  const issued = issueTicket(state, plan.candidate, context.now, "issued", plan.decision);
  const result = resolveAndReissueTicket(issued.state, "issued", { kind: "invalid", reason: "BAD_PRIORITY" }, context.now, "replacement");
  assert.equal(result.kind, "success");
  assert.equal(result.state.tickets.filter((ticket) => ticket.status === "ACTIVE").length, 1);
  assert.equal(getActiveTicket(result.state)?.sourceId, "second");
  const invalid = result.state.tickets.find((ticket) => ticket.id === "issued");
  assert.equal(invalid?.status, "INVALID");
  assert.equal(invalid?.invalidDecision?.ticketId, "issued");
  assert.equal(invalid?.invalidDecision?.selectedAction, plan.candidate.action);
  const repeated = resolveAndReissueTicket(result.state, "issued", { kind: "invalid", reason: "OTHER" }, context.now, "duplicate");
  assert.equal(repeated.kind, "conflict");
  assert.equal(repeated.state, result.state);
  assert.equal(failTicket(result.state, "issued", "other", context.now).kind, "conflict");
});

/** Preserves the feedback cooldown after unrelated resolutions, then permits a full-duration retry at expiry. */
test("Task quality cooldown survives other directives without applying failure shrinkage", () => {
  const context = createPlannerContext({ tasks: [createTask()] });
  const active = createTaskTicket("ACTIVE", { createdAt: context.now.toISOString() });
  const invalid = invalidateTicket({ ...createInitialState(), tasks: context.tasks, tickets: [active] }, active.id, "CONTEXT_MISMATCH", context.now);
  const later = new Date(context.now.getTime() + 5 * 60_000);
  const unrelated = createTaskTicket("COMPLETED", { id: "other", sourceType: "SYSTEM", sourceId: "fallback:water", createdAt: later.toISOString(), completedAt: later.toISOString() });
  const recentTickets = [unrelated, ...invalid.state.tickets];
  const blocked = planNextTicketWithDecision({ ...context, now: later, recentTickets });
  assert.equal(blocked.candidate.sourceType, "SYSTEM");
  assert.match(blocked.decision.candidates.find((item) => item.sourceId === "task")?.reason ?? "", /이상 지령 피드백/);
  const retry = planNextTicket({ ...context, now: new Date(context.now.getTime() + 30 * 60_000), recentTickets });
  assert.equal(retry.sourceType, "TASK");
  assert.equal(retry.expectedMinutes, 30);
});

/** Ensures Routine feedback suppresses its source without falsely counting that occurrence as a user failure. */
test("Routine quality feedback blocks immediate reissuance but is not an execution failure", () => {
  const context = createPlannerContext({ idealRoutines: [{ id: "routine", title: "운동", startTime: "10:00", endTime: "11:00", daysOfWeek: [2], category: "exercise", priority: 5, enabled: true }] });
  const plan = planNextTicketWithDecision(context);
  const issued = issueTicket({ ...createInitialState(), idealRoutines: context.idealRoutines }, plan.candidate, context.now, "routine-ticket", plan.decision);
  const invalid = invalidateTicket(issued.state, "routine-ticket", "ALREADY_DONE", context.now);
  const next = planNextTicketWithDecision({ ...context, recentTickets: invalid.state.tickets });
  assert.notEqual(next.candidate.sourceId, "routine");
  assert.match(next.decision.candidates.find((item) => item.sourceId === "routine")?.reason ?? "", /이상 지령/);
  assert.equal(invalid.state.tickets.filter((ticket) => ticket.status === "FAILED").length, 0);
});

/** Distinguishes identical source IDs in different domains when suppressing an invalid current schedule. */
test("quality suppression uses both sourceType and sourceId", () => {
  const context = createPlannerContext({
    tasks: [createTask({ id: "shared" })],
    localSchedule: [{ id: "shared", title: "일정", startAt: new Date(2026, 9, 6, 9, 30).toISOString(), endAt: new Date(2026, 9, 6, 10, 30).toISOString(), type: "work" }],
  });
  const plan = planNextTicketWithDecision(context);
  const issued = issueTicket({ ...createInitialState(), tasks: context.tasks, localScheduleItems: context.localSchedule }, plan.candidate, context.now, "schedule-ticket", plan.decision);
  const result = resolveAndReissueTicket(issued.state, "schedule-ticket", { kind: "invalid", reason: "CONTEXT_MISMATCH" }, context.now, "next");
  assert.equal(getActiveTicket(result.state)?.sourceType, "TASK");
  assert.equal(getActiveTicket(result.state)?.sourceId, "shared");
});

/** Checks System rotation through repeated quality reports without ever immediately returning the same source. */
test("System invalid reports advance rotation without increasing failure totals", () => {
  const context = createPlannerContext();
  const firstPlan = planNextTicketWithDecision(context);
  let state = issueTicket(createInitialState(), firstPlan.candidate, context.now, "first", firstPlan.decision).state;
  for (let index = 0; index < 6; index += 1) {
    const active = getActiveTicket(state);
    assert.ok(active);
    const result = resolveAndReissueTicket(state, active.id, { kind: "invalid", reason: "TOO_REPETITIVE" }, new Date(context.now.getTime() + index * 1000), `next-${index}`);
    assert.equal(result.kind, "success");
    assert.notEqual(getActiveTicket(result.state)?.sourceId, active.sourceId);
    assert.equal(result.state.tickets.filter((ticket) => ticket.status === "ACTIVE").length, 1);
    state = result.state;
  }
  assert.equal(state.tickets.filter((ticket) => ticket.status === "FAILED").length, 0);
  assert.equal(getInvalidDirectiveHistory(state.tickets).length, 6);
});

/** Avoids repeating an invalid passive waiting directive when no five-minute work window exists. */
test("a rejected System waiting directive receives a different waiting source", () => {
  const context = createPlannerContext({
    localSchedule: [{ id: "meeting", title: "회의", startAt: new Date(2026, 9, 6, 10, 9).toISOString(), endAt: new Date(2026, 9, 6, 11, 0).toISOString(), type: "work" }],
    recentTickets: [createTaskTicket("INVALID", { id: "schedule-feedback", sourceType: "SCHEDULE", sourceId: "meeting", invalidReason: "TIME_IMPOSSIBLE", invalidatedAt: new Date(2026, 9, 6, 9, 59).toISOString() })],
  });
  const plan = planNextTicketWithDecision(context);
  assert.equal(plan.candidate.sourceId, "system:wait-for-schedule");
  const issued = issueTicket({ ...createInitialState(), localScheduleItems: context.localSchedule, tickets: context.recentTickets }, plan.candidate, context.now, "waiting", plan.decision);
  const result = resolveAndReissueTicket(issued.state, "waiting", { kind: "invalid", reason: "OTHER" }, context.now, "next-waiting");
  assert.notEqual(getActiveTicket(result.state)?.sourceId, "system:wait-for-schedule");
  assert.equal(getActiveTicket(result.state)?.sourceType, "SYSTEM");
});

/** Retains original decision evidence beyond the rolling log and through a portable backup round-trip. */
test("invalid feedback snapshots survive log trimming and backup restore", () => {
  const context = createPlannerContext({ tasks: [createTask()] });
  const plan = planNextTicketWithDecision(context);
  const issued = issueTicket({ ...createInitialState(), tasks: context.tasks }, plan.candidate, context.now, "reported", plan.decision);
  const invalid = invalidateTicket(issued.state, "reported", "BAD_PRIORITY", context.now);
  const trimmed = { ...invalid.state, plannerDecisions: [] };
  const restored = parseStateBackup(JSON.parse(JSON.stringify(createStateBackup(trimmed, context.now))) as unknown);
  assert.ok(restored);
  assert.equal(restored.tickets[0].status, "INVALID");
  assert.equal(restored.tickets[0].invalidReason, "BAD_PRIORITY");
  assert.equal(restored.tickets[0].invalidDecision?.availableMinutes, plan.decision.availableMinutes);
  assert.equal(restored.tickets[0].invalidDecision?.selectedReason, plan.decision.selectedReason);
  assert.equal(restored.tickets[0].failureReason, undefined);
  assert.equal(restored.tickets[0].completedAt, undefined);
});

/** Covers the transition buffer, whole-minute rounding, cap, and recurrence across midnight. */
test("available windows reserve five minutes and never exceed 120 minutes", () => {
  const current = new Date(2026, 9, 6, 10, 0);
  const meeting = {
    id: "meeting", title: "회의", type: "work" as const,
    startAt: new Date(2026, 9, 6, 14, 0).toISOString(),
    endAt: new Date(2026, 9, 6, 15, 0).toISOString(),
  };
  assert.equal(getAvailableWindow(current, []), 120);
  assert.equal(getAvailableWindow(current, [meeting]), 120);
  assert.equal(getAvailableWindow(current, [{ ...meeting, startAt: new Date(2026, 9, 6, 10, 9, 59).toISOString() }]), 4);
  assert.equal(getAvailableWindow(current, [{ ...meeting, startAt: new Date(2026, 9, 6, 10, 10).toISOString() }]), 5);
  assert.equal(getAvailableWindow(current, [{ ...meeting, startAt: new Date(2026, 9, 6, 10, 3).toISOString() }]), 0);
  const nightlySchedule = {
    ...meeting,
    startAt: new Date(2026, 9, 5, 0, 10).toISOString(),
    endAt: new Date(2026, 9, 5, 0, 40).toISOString(),
    recurrence: { frequency: "DAILY" as const },
  };
  assert.equal(getAvailableWindow(new Date(2026, 9, 6, 23, 50), [nightlySchedule]), 15);
});

/** Locks exact deadline bucket boundaries including undated and overdue work. */
test("Task deadline tiers change only at the documented time boundaries", () => {
  const current = new Date(2026, 9, 6, 10, 0);
  const cases = [[-1, 0], [0, 0], [6, 1], [6.001, 2], [24, 2], [24.001, 3], [72, 3], [72.001, 4], [168, 4], [168.001, 5]];
  for (const [hours, expectedTier] of cases) {
    const task = createTask({ dueAt: new Date(current.getTime() + hours * 3_600_000).toISOString() });
    assert.equal(getDeadlineTier(task, current), expectedTier);
  }
  assert.equal(getDeadlineTier(createTask(), current), 5);
});

/** Verifies that the 72-hour urgent boundary controls Task-versus-Routine selection regardless of importance. */
test("urgent Tasks outrank Routines until the exact three-day cutoff", () => {
  const context = createPlannerContext({
    idealRoutines: [{ id: "routine", title: "운동", startTime: "10:00", endTime: "11:00", daysOfWeek: [2], category: "exercise", priority: 5, enabled: true }],
  });
  const urgent = createTask({ importance: 1, dueAt: new Date(context.now.getTime() + 72 * 3_600_000).toISOString() });
  assert.equal(planNextTicket({ ...context, tasks: [urgent] }).sourceType, "TASK");
  const normal = { ...urgent, importance: 5 as const, dueAt: new Date(context.now.getTime() + 72 * 3_600_000 + 1).toISOString() };
  assert.equal(planNextTicket({ ...context, tasks: [normal] }).sourceType, "ROUTINE");
});

/** Verifies that importance outranks exact deadlines inside the same bucket, while the closer bucket always wins. */
test("Task sorting compares deadline buckets before importance", () => {
  const context = createPlannerContext();
  const earlier = createTask({ id: "earlier", importance: 1, dueAt: new Date(context.now.getTime() + 3_600_000).toISOString() });
  const important = createTask({ id: "important", importance: 5, dueAt: new Date(context.now.getTime() + 5 * 3_600_000).toISOString() });
  const plan = planNextTicketWithDecision({ ...context, tasks: [earlier, important] });
  assert.equal(plan.candidate.sourceId, "important");
  assert.match(plan.candidate.selectionReason ?? "", /중요도\(5\)가 가장 높아/);
  const overdue = createTask({ id: "overdue", importance: 1, dueAt: new Date(context.now.getTime() - 1).toISOString() });
  assert.equal(planNextTicket({ ...context, tasks: [important, overdue] }).sourceId, "overdue");
});

/** Uses issue time, rather than completion time or input position, to prefer the longest-unselected Task. */
test("Task ordering uses selection history and then stable IDs", () => {
  const context = createPlannerContext({ now: new Date(2026, 9, 6, 12, 0) });
  const first = createTask({ id: "first" });
  const second = createTask({ id: "second" });
  const tickets = [
    createTaskTicket("COMPLETED", { id: "first-ticket", sourceId: "first", createdAt: new Date(2026, 9, 6, 9, 0).toISOString(), completedAt: new Date(2026, 9, 6, 11, 30).toISOString() }),
    createTaskTicket("COMPLETED", { id: "second-ticket", sourceId: "second", createdAt: new Date(2026, 9, 6, 9, 30).toISOString(), completedAt: new Date(2026, 9, 6, 10, 0).toISOString() }),
  ];
  assert.equal(planNextTicket({ ...context, tasks: [second, first], recentTickets: tickets }).sourceId, "first");
  const neverSelected = createTask({ id: "never" });
  assert.equal(planNextTicket({ ...context, tasks: [first, neverSelected], recentTickets: tickets }).sourceId, "never");
  const tiedTasks = [createTask({ id: "b" }), createTask({ id: "a" })];
  const originalInput = JSON.stringify(tiedTasks);
  const plan = planNextTicketWithDecision({ ...context, tasks: tiedTasks });
  assert.equal(plan.candidate.sourceId, "a");
  assert.deepEqual(plan, planNextTicketWithDecision({ ...context, tasks: [...tiedTasks].reverse() }));
  assert.equal(JSON.stringify(tiedTasks), originalInput);
});

/** Allows a Routine to run in the shared free portion before a later fixed schedule overlaps its full window. */
test("Routines use the same available window as Tasks", () => {
  const context = createPlannerContext({
    idealRoutines: [{ id: "study", title: "공부", startTime: "10:00", endTime: "11:30", daysOfWeek: [2], category: "study", priority: 3, enabled: true }],
    localSchedule: [{ id: "meeting", title: "회의", startAt: new Date(2026, 9, 6, 10, 25).toISOString(), endAt: new Date(2026, 9, 6, 11, 0).toISOString(), type: "work" }],
  });
  const plan = planNextTicketWithDecision(context);
  assert.equal(plan.candidate.sourceType, "ROUTINE");
  assert.equal(plan.candidate.expectedMinutes, 20);
  assert.equal(plan.decision.availableMinutes, 20);
});

/** Excludes urgent but unworkable Tasks and Routine windows shorter than five complete minutes. */
test("infeasible candidates do not block a lower priority layer", () => {
  const context = createPlannerContext({
    tasks: [createTask({ estimatedMinutes: 4, dueAt: new Date(2026, 9, 6, 11, 0).toISOString() })],
    idealRoutines: [{ id: "routine", title: "공부", startTime: "10:00", endTime: "11:00", daysOfWeek: [2], category: "study", priority: 3, enabled: true }],
  });
  assert.equal(planNextTicket(context).sourceType, "ROUTINE");
  const nearlyFinished = { ...context.idealRoutines[0], endTime: "10:05" };
  assert.equal(planNextTicket({ ...context, tasks: [], now: new Date(2026, 9, 6, 10, 0, 1), idealRoutines: [nearlyFinished] }).sourceType, "SYSTEM");
});

/** Ensures preparations take priority over overdue work without extending a short window during a failure retry. */
test("schedule preparation outranks urgent work and respects a short retry window", () => {
  const context = createPlannerContext({
    tasks: [createTask({ dueAt: new Date(2026, 9, 6, 9, 0).toISOString() })],
    localSchedule: [{ id: "meeting", title: "회의", startAt: new Date(2026, 9, 6, 10, 2).toISOString(), endAt: new Date(2026, 9, 6, 11, 0).toISOString(), type: "work" }],
    recentTickets: [createTaskTicket("FAILED", { sourceType: "SCHEDULE", sourceId: "meeting", failureReason: "time_shortage", completedAt: new Date(2026, 9, 6, 10, 0).toISOString() })],
  });
  const result = planNextTicket(context);
  assert.equal(result.sourceType, "SCHEDULE");
  assert.equal(result.expectedMinutes, 2);
});

/** Keeps the five-minute execution filter active when imminent schedule preparation is on cooldown. */
test("a short free window excludes work and produces a waiting directive", () => {
  const context = createPlannerContext({
    tasks: [createTask()],
    localSchedule: [{ id: "meeting", title: "회의", startAt: new Date(2026, 9, 6, 10, 9).toISOString(), endAt: new Date(2026, 9, 6, 11, 0).toISOString(), type: "work" }],
    recentTickets: [createTaskTicket("FAILED", { sourceType: "SCHEDULE", sourceId: "meeting", failureReason: "schedule_changed", completedAt: new Date(2026, 9, 6, 10, 0).toISOString() })],
  });
  const plan = planNextTicketWithDecision(context);
  assert.equal(plan.decision.availableMinutes, 4);
  assert.equal(plan.candidate.sourceId, "system:wait-for-schedule");
  assert.equal(plan.decision.candidates.find((candidate) => candidate.sourceType === "TASK")?.disposition, "EXCLUDED");
});

/** Keeps the chosen Task's sorting inputs and reduced-duration explanation through state persistence and backup. */
test("tier decisions persist Task ordering inputs and failure adjustments", () => {
  const context = createPlannerContext({
    tasks: [createTask()],
    recentTickets: [createTaskTicket("FAILED", { failureReason: "time_shortage", createdAt: new Date(2026, 9, 6, 9, 0).toISOString(), completedAt: new Date(2026, 9, 6, 9, 30).toISOString() })],
  });
  const plan = planNextTicketWithDecision(context);
  assert.equal(plan.candidate.expectedMinutes, 15);
  assert.match(plan.candidate.selectionReason ?? "", /15분으로 축소/);
  const issued = issueTicket(createInitialState(), plan.candidate, context.now, "issued", plan.decision);
  const restored = parseStateBackup(JSON.parse(JSON.stringify(createStateBackup(issued.state, context.now))) as unknown);
  assert.ok(restored);
  const selected = restored.plannerDecisions[0].candidates.find((candidate) => candidate.disposition === "SELECTED");
  assert.equal(selected?.priorityLayer, 5);
  assert.equal(selected?.deadlineTier, 5);
  assert.equal(selected?.importance, 3);
  assert.equal(selected?.lastExecutedAt, new Date(2026, 9, 6, 9, 0).toISOString());
  assert.equal(restored.tickets[0].selectionReason, restored.plannerDecisions[0].selectedReason);
});

/** Verifies that a fixed schedule takes precedence over an overlapping ideal routine. */
test("Planner prioritizes an actual schedule over an overlapping routine", () => {
  const current = new Date(2026, 9, 6, 20, 0);
  const state = createInitialState();
  const candidate = planNextTicket({
    now: current,
    tasks: [createTask()],
    localSchedule: [{
      id: "dinner", title: "저녁 약속", startAt: new Date(2026, 9, 6, 19, 30).toISOString(),
      endAt: new Date(2026, 9, 6, 21, 30).toISOString(), type: "appointment", recurrence: { frequency: "NONE" },
    }],
    idealRoutines: [{ id: "exercise", title: "운동", startTime: "20:00", endTime: "21:00", daysOfWeek: [2], category: "exercise", priority: 5, enabled: true }],
    recentTickets: [], settings: state.settings,
  });
  assert.equal(candidate.sourceType, "SCHEDULE");
  assert.equal(candidate.sourceId, "dinner");
});

/** Verifies that a long Task is reduced to the time available before a schedule. */
test("Planner bounds a long Task by available time", () => {
  const current = new Date(2026, 9, 6, 10, 0);
  const schedule = [{
    id: "meeting", title: "회의", startAt: new Date(2026, 9, 6, 10, 25).toISOString(),
    endAt: new Date(2026, 9, 6, 11, 0).toISOString(), type: "work" as const, recurrence: { frequency: "NONE" as const },
  }];
  assert.equal(getAvailableMinutes(current, schedule), 20);
  const state = createInitialState();
  const candidate = planNextTicket({ now: current, tasks: [createTask()], localSchedule: schedule, idealRoutines: [], recentTickets: [], settings: state.settings });
  assert.equal(candidate.sourceType, "TASK");
  assert.equal(candidate.expectedMinutes, 20);
  assert.equal(candidate.action, "자료구조 과제를 20분간 진행할 것.");
});

/** Verifies that a near deadline outranks a more important undated Task. */
test("Planner prioritizes a near deadline", () => {
  const current = new Date(2026, 9, 6, 10, 0);
  const state = createInitialState();
  const candidate = planNextTicket({
    now: current,
    tasks: [
      createTask({ id: "important", title: "언젠가 할 일", importance: 5 }),
      createTask({ id: "urgent", title: "곧 마감", importance: 1, dueAt: new Date(current.getTime() + 2 * 60 * 60_000).toISOString() }),
    ],
    localSchedule: [], idealRoutines: [], recentTickets: [], settings: state.settings,
  });
  assert.equal(candidate.sourceId, "urgent");
});

/** Verifies that the selected and rejected Planner candidates are persisted with the issued ticket. */
test("Planner records a deterministic decision trail", () => {
  const current = new Date(2026, 9, 6, 10, 0);
  const state = createInitialState();
  const plan = planNextTicketWithDecision({
    now: current,
    tasks: [
      createTask({ id: "selected", title: "오늘 과제", importance: 5 }),
      createTask({ id: "done", title: "끝난 일", status: "DONE" }),
    ],
    localSchedule: [], idealRoutines: [], recentTickets: [], settings: state.settings,
  });
  const issued = issueTicket(state, plan.candidate, current, "issued", plan.decision);

  assert.equal(plan.candidate.sourceId, "selected");
  assert.equal(plan.decision.candidates.find((candidate) => candidate.sourceId === "selected")?.disposition, "SELECTED");
  assert.equal(plan.decision.candidates.find((candidate) => candidate.sourceId === "done")?.disposition, "EXCLUDED");
  assert.equal(issued.state.plannerDecisions[0].ticketId, "issued");
});

/** Verifies that a routine in its current time window is selected over a non-urgent Task. */
test("Planner selects a routine in its current window", () => {
  const current = new Date(2026, 9, 6, 22, 30);
  const state = createInitialState();
  const candidate = planNextTicket({
    now: current, tasks: [createTask({ importance: 1 })], localSchedule: [],
    idealRoutines: [{ id: "study", title: "저녁 공부", startTime: "22:00", endTime: "23:30", daysOfWeek: [2], category: "study", priority: 3, enabled: true }],
    recentTickets: [], settings: state.settings,
  });
  assert.equal(candidate.sourceType, "ROUTINE");
  assert.equal(candidate.sourceId, "study");
  assert.equal(candidate.action, "저녁 공부를 30분간 수행할 것.");
});

/** Verifies that a time-shortage failure produces a smaller retry chunk. */
test("Planner shortens the same Task after a time-shortage failure", () => {
  const current = new Date(2026, 9, 6, 11, 0);
  const state = createInitialState();
  const failed = createTaskTicket("FAILED", { failureReason: "time_shortage", completedAt: current.toISOString() });
  const candidate = planNextTicket({ now: current, tasks: [createTask()], localSchedule: [], idealRoutines: [], recentTickets: [failed], settings: state.settings });
  assert.equal(candidate.sourceId, "task");
  assert.equal(candidate.expectedMinutes, 15);
});

/** Verifies that a changed schedule is not immediately reissued after failure. */
test("Planner replans away from a schedule that just failed because it changed", () => {
  const current = new Date(2026, 9, 6, 20, 0);
  const state = createInitialState();
  const failedSchedule: Ticket = {
    ...createTaskTicket("FAILED"), sourceType: "SCHEDULE", sourceId: "dinner",
    failureReason: "schedule_changed", completedAt: current.toISOString(),
  };
  const candidate = planNextTicket({
    now: current,
    tasks: [createTask()],
    localSchedule: [{
      id: "dinner", title: "취소된 약속", startAt: new Date(2026, 9, 6, 19, 30).toISOString(),
      endAt: new Date(2026, 9, 6, 21, 0).toISOString(), type: "appointment", recurrence: { frequency: "NONE" },
    }],
    idealRoutines: [], recentTickets: [failedSchedule], settings: state.settings,
  });
  assert.equal(candidate.sourceType, "TASK");
  assert.equal(candidate.sourceId, "task");
});

/** Verifies that an unrelated resolution does not hide a still-active source cooldown. */
test("Planner keeps a source cooldown after another directive resolves", () => {
  const current = new Date(2026, 9, 6, 20, 0);
  const state = createInitialState();
  const failedTask = createTaskTicket("FAILED", {
    failureReason: "place_or_tools",
    completedAt: new Date(current.getTime() - 30 * 60_000).toISOString(),
  });
  const unrelatedTicket: Ticket = {
    ...createTaskTicket("COMPLETED"),
    id: "unrelated",
    sourceType: "SYSTEM",
    sourceId: "fallback:water",
    completedAt: current.toISOString(),
  };
  const candidate = planNextTicket({
    now: current,
    tasks: [createTask()],
    localSchedule: [],
    idealRoutines: [],
    recentTickets: [unrelatedTicket, failedTask],
    settings: state.settings,
  });
  assert.equal(candidate.sourceType, "SYSTEM");
});

/** Verifies that failure transitions persist an explicit cooldown expiry. */
test("stores a cooldown expiry for blocking failure reasons", () => {
  const active = createTaskTicket("ACTIVE");
  const state: AppState = { ...createInitialState(), tickets: [active] };
  const failed = failTicket(state, active.id, "physical_condition", now);
  assert.equal(failed.state.tickets[0].cooldownUntil, new Date(now.getTime() + 240 * 60_000).toISOString());
});

/** Verifies that elapsed failures suppress the same source during the same local day. */
test("Planner does not immediately reissue an elapsed Task", () => {
  const current = new Date(2026, 9, 6, 20, 0);
  const state = createInitialState();
  const failed = createTaskTicket("FAILED", { failureReason: "time_elapsed", completedAt: current.toISOString() });
  const candidate = planNextTicket({
    now: current, tasks: [createTask()], localSchedule: [], idealRoutines: [], recentTickets: [failed], settings: state.settings,
  });
  assert.equal(candidate.sourceType, "SYSTEM");
});

/** Verifies that the deterministic System cycle reaches the stretching fallback. */
test("Planner rotates System fallbacks and includes stretching", () => {
  const current = new Date(2026, 9, 6, 20, 0);
  const state = createInitialState();
  const resolvedFallbacks = ["tidy", "water", "walk", "rest"].map((name, index): Ticket => ({
    ...createTaskTicket("COMPLETED"),
    id: `fallback-${index}`,
    sequence: index + 1,
    sourceType: "SYSTEM",
    sourceId: `fallback:${name}`,
    completedAt: current.toISOString(),
  }));
  const candidate = planNextTicket({
    now: current, tasks: [], localSchedule: [], idealRoutines: [], recentTickets: resolvedFallbacks, settings: state.settings,
  });
  assert.equal(candidate.sourceId, "fallback:stretch");
  assert.equal(candidate.action, "5분간 스트레칭할 것.");
});

/** Verifies stale review timing without rejecting a newly issued overdue Task. */
test("detects stale active tickets without flagging an already overdue deadline immediately", () => {
  const issuedAt = new Date(2026, 9, 6, 10, 0);
  const ticket = createTaskTicket("ACTIVE", {
    createdAt: issuedAt.toISOString(),
    deadline: new Date(2026, 9, 6, 9, 0).toISOString(),
  });
  assert.equal(getActiveTicketStaleness(ticket, new Date(2026, 9, 6, 10, 1)), null);
  assert.match(getActiveTicketStaleness(ticket, new Date(2026, 9, 6, 12, 1))?.reason ?? "", /121분/);
});

/** Verifies that completing a Task ticket advances progress and marks a fully completed Task done. */
test("completing a Task ticket advances Task progress", () => {
  const task = createTask({ estimatedMinutes: 30 });
  const ticket = createTaskTicket("ACTIVE");
  const state: AppState = { ...createInitialState(), tasks: [task], tickets: [ticket] };
  const result = completeTicket(state, ticket.id, now);
  assert.equal(result.kind, "success");
  assert.equal(result.state.tasks[0].completedMinutes, 30);
  assert.equal(result.state.tasks[0].status, "DONE");
});
