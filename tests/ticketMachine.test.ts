import assert from "node:assert/strict";
import test from "node:test";
import { createDecryptionFrame } from "../src/lib/decryption.ts";
import { formatDirectiveTiming, getDirectiveDisplayDeadline, getOverdueTaskDeadline } from "../src/lib/directiveTiming.ts";
import {
  coordinateTicketSignal,
  createTicketPrintPlan,
  createTicketSignalPlan,
  failureAlertAssetPath,
  informationBeepAssetPath,
  ticketSignalAssetPath,
  ticketWaitLoopAssetPath,
} from "../src/lib/ticketSignal.ts";
import {
  completeTicket,
  createInitialState,
  failTicket,
  getActiveTicket,
  getActiveTicketStaleness,
  continueTicket,
  getTicketExpectedEndAt,
  happinessEasterEggSourceId,
  isUnlimitedDurationTicket,
  issueTicket,
  invalidateTicket,
  normalizeState,
} from "../src/lib/ticketMachine.ts";
import { createStateBackup, migrateV1State, parseStateBackup } from "../src/lib/stateMigration.ts";
import {
  createIdealRoutine,
  createLocalScheduleItem,
  getRoutineOverlapConflicts,
  getRoutineWindow,
  normalizeTimeInput,
  scheduleOccursOnDate,
} from "../src/lib/calendar.ts";
import {
  getAvailableMinutes,
  getAvailableWindow,
  getDeadlineTier,
  planNextTicket as planOptionalTicket,
  planNextTicketWithDecision as evaluatePlanner,
  type PlannerContext,
} from "../src/lib/planner.ts";
import { planAndIssueTicket, replanForUserContext, resolveAndReissueTicket, saveUserContextState } from "../src/lib/ticketLifecycle.ts";
import {
  createDefaultUserContext, getActiveContextConflict, getContextExclusion, getNextContextExpiry,
  normalizeUserContext, resolveEffectiveContext,
} from "../src/lib/userContext.ts";
import { getInvalidDirectiveHistory } from "../src/lib/directiveFeedback.ts";
import { getCurrentRoutineStep, getRoutineStepProgress, getRoutineTicketWindow } from "../src/lib/routineProgress.ts";
import { appendObjectParticle } from "../src/lib/koreanParticle.ts";
import {
  advanceNavigationRevealSequence,
  createNavigationRevealSequence,
  navigationIdleMs,
} from "../src/lib/navigationVisibility.ts";
import type { AppState, IdealRoutine, LocalScheduleItem, Task, Ticket, TicketCandidate } from "../src/lib/ticketMachine.ts";
import {
  createAndroidNotificationChannel,
  getNotificationSoundOptions,
  notificationChannelId,
  notificationSoundFile,
} from "../src/lib/notificationSound.ts";

/** Existing ordinary-context fixtures require an action; deferred behavior is asserted through evaluatePlanner below. */
function planNextTicket(context: PlannerContext): TicketCandidate {
  const candidate = planOptionalTicket(context);
  assert.ok(candidate, "ordinary-context fixture unexpectedly deferred");
  return candidate;
}

/** Explicitly narrows the tagged result for legacy action-selection regression cases. */
function planNextTicketWithDecision(context: PlannerContext) {
  const plan = evaluatePlanner(context);
  assert.ok(plan.kind === "DIRECTIVE", "ordinary-context fixture unexpectedly deferred");
  return plan;
}

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

/** Resolves Korean final consonants, digits, punctuation and unknown pronunciation without 을(를). */
test("renders one concrete Korean object particle", () => {
  assert.equal(appendObjectParticle("운동"), "운동을");
  assert.equal(appendObjectParticle("과제"), "과제를");
  assert.equal(appendObjectParticle("과제!"), "“과제!”를");
  assert.equal(appendObjectParticle("문제 1"), "문제 1을");
  assert.equal(appendObjectParticle("PT"), "“PT” 항목을");
  assert.doesNotMatch(appendObjectParticle("PT"), /을\(를\)/);
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
  assert.equal(failureAlertAssetPath, "/audio/failure-alert.wav");
  assert.equal(informationBeepAssetPath, "/audio/information-beep.wav");
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
  assert.equal(migrated.settings.systemFallbacks.at(-1)?.id, "stretch");
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
    category: "study", priority: 4, enabled: true, timingMode: "FIXED",
  }, "routine");
  assert.equal(result.kind, "success");
  if (result.kind !== "success") return;
  assert.ok(getRoutineWindow(result.value, new Date(2026, 9, 6)));
  assert.equal(getRoutineWindow(result.value, new Date(2026, 9, 11)), null);
});

/** Rejects ambiguous full-day windows while retaining explicit overnight routine support. */
test("routine time validation distinguishes identical and next-day end times", () => {
  const shared = {
    title: "야간 루틴", daysOfWeek: [2], category: "personal" as const,
    priority: 3, enabled: true, timingMode: "FIXED" as const,
  };
  const ambiguous = createIdealRoutine({ ...shared, startTime: "00:00", endTime: "00:00" }, "ambiguous");
  assert.equal(ambiguous.kind, "invalid");
  const overnight = createIdealRoutine({ ...shared, startTime: "05:00", endTime: "04:00" }, "overnight");
  assert.equal(overnight.kind, "success");
  if (overnight.kind !== "success") return;
  const window = getRoutineWindow(overnight.value, new Date(2026, 9, 6));
  assert.equal(window?.endAt.getDate(), 7);
  assert.equal((window!.endAt.getTime() - window!.startAt.getTime()) / 60_000, 23 * 60);
});

/** Accepts direct 24-hour keyboard entry while rejecting impossible clock values. */
test("normalizes direct routine time entry", () => {
  assert.equal(normalizeTimeInput("5:30"), "05:30");
  assert.equal(normalizeTimeInput("2030"), "20:30");
  assert.equal(normalizeTimeInput("24:00"), null);
  assert.equal(normalizeTimeInput("12:60"), null);
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
  const context = createPlannerContext({ idealRoutines: [{ id: "routine", title: "운동", startTime: "10:00", endTime: "11:00", daysOfWeek: [2], category: "exercise", priority: 5, enabled: true, timingMode: "FIXED" }] });
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

/** Covers transition buffers, fixed routine boundaries, whole-minute rounding, cap, and recurrence. */
test("available windows use the earliest schedule or routine boundary", () => {
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
  const exerciseRoutine = {
    id: "exercise", title: "운동", startTime: "20:00", endTime: "21:00",
    daysOfWeek: [2], category: "exercise" as const, priority: 3, enabled: true, timingMode: "FIXED" as const,
  };
  assert.equal(getAvailableWindow(new Date(2026, 9, 6, 19, 40), [], [exerciseRoutine]), 15);
  assert.equal(getAvailableWindow(
    new Date(2026, 9, 6, 19, 40),
    [{
      ...meeting,
      startAt: new Date(2026, 9, 6, 19, 50).toISOString(),
      endAt: new Date(2026, 9, 6, 20, 50).toISOString(),
    }],
    [exerciseRoutine],
  ), 5);
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
    idealRoutines: [{ id: "routine", title: "운동", startTime: "10:00", endTime: "11:00", daysOfWeek: [2], category: "exercise", priority: 5, enabled: true, timingMode: "FIXED" }],
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
    idealRoutines: [{ id: "study", title: "공부", startTime: "10:00", endTime: "11:30", daysOfWeek: [2], category: "study", priority: 3, enabled: true, timingMode: "FIXED" }],
    localSchedule: [{ id: "meeting", title: "회의", startAt: new Date(2026, 9, 6, 10, 25).toISOString(), endAt: new Date(2026, 9, 6, 11, 0).toISOString(), type: "work" }],
  });
  const plan = planNextTicketWithDecision(context);
  assert.equal(plan.candidate.sourceType, "ROUTINE");
  assert.equal(plan.candidate.expectedMinutes, 20);
  assert.equal(plan.decision.availableMinutes, 20);
});

/** Excludes zero-work Tasks and ordinary Routine windows shorter than five complete minutes. */
test("infeasible candidates do not block a lower priority layer", () => {
  const context = createPlannerContext({
    tasks: [createTask({ estimatedMinutes: 5, completedMinutes: 5, dueAt: new Date(2026, 9, 6, 11, 0).toISOString() })],
    idealRoutines: [{ id: "routine", title: "공부", startTime: "10:00", endTime: "11:00", daysOfWeek: [2], category: "study", priority: 3, enabled: true, timingMode: "FIXED" }],
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
  assert.equal(plan.candidate.expectedMinutes, 9);
  assert.equal(plan.candidate.deadline, new Date(2026, 9, 6, 10, 9).toISOString());
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
    idealRoutines: [{ id: "exercise", title: "운동", startTime: "20:00", endTime: "21:00", daysOfWeek: [2], category: "exercise", priority: 5, enabled: true, timingMode: "FIXED" }],
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
  assert.equal(candidate.action, "20분 동안 자료구조 과제를 진행할 것.");
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
    idealRoutines: [{ id: "study", title: "저녁 공부", startTime: "22:00", endTime: "23:30", daysOfWeek: [2], category: "study", priority: 3, enabled: true, timingMode: "FIXED" }],
    recentTickets: [], settings: state.settings,
  });
  assert.equal(candidate.sourceType, "ROUTINE");
  assert.equal(candidate.sourceId, "study");
  assert.equal(candidate.action, "30분 동안 저녁 공부할 것.");
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

/** Gives one deterministic happiness result across each complete set of two hundred fallback slots. */
test("Planner exposes the deterministic 0.5 percent fallback Easter egg", () => {
  const current = new Date(2026, 9, 6, 20, 0);
  const state = createInitialState();
  const candidates = Array.from({ length: 200 }, (_, resolvedCount) => {
    const resolvedFallbacks = Array.from({ length: resolvedCount }, (__, index): Ticket => ({
      ...createTaskTicket("COMPLETED"),
      id: `resolved-fallback-${resolvedCount}-${index}`,
      sequence: index + 1,
      sourceType: "SYSTEM",
      sourceId: `fallback:${index % 2 === 0 ? "tidy" : "water"}`,
      completedAt: current.toISOString(),
    }));
    return planNextTicket({
      now: current, tasks: [], localSchedule: [], idealRoutines: [], recentTickets: resolvedFallbacks, settings: state.settings,
    });
  });
  const easterEggs = candidates.filter((candidate) => candidate.sourceId === happinessEasterEggSourceId);
  assert.equal(easterEggs.length, 1);
  const candidate = easterEggs[0];
  assert.ok(candidate);
  assert.equal(candidate.sourceId, happinessEasterEggSourceId);
  assert.equal(candidate.action, "행복할 것. 기간은 무제한");
  assert.equal(isUnlimitedDurationTicket({ sourceType: candidate.sourceType, sourceId: candidate.sourceId }), true);
});

/** Uses saved fallback order and stable IDs instead of a hard-coded Planner-only list. */
test("Planner uses user-configured System fallbacks deterministically", () => {
  const current = new Date(2026, 9, 6, 20, 0);
  const state = createInitialState();
  const candidate = planNextTicket({
    now: current,
    tasks: [],
    localSchedule: [],
    idealRoutines: [],
    recentTickets: [],
    settings: {
      ...state.settings,
      systemFallbacks: [{ id: "ventilate", action: "창문을 열고 환기할 것.", expectedMinutes: 3 }],
    },
  });
  assert.equal(candidate.sourceId, "fallback:ventilate");
  assert.equal(candidate.action, "창문을 열고 환기할 것.");
  assert.equal(candidate.expectedMinutes, 3);
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

/** Unestimated work has a real completion, not an endless sequence of completed execution blocks. */
test("completing an unestimated Task saves DONE before issuing a different source", () => {
  const task = createTask({ estimatedMinutes: undefined });
  const active = createTaskTicket("ACTIVE");
  const state: AppState = { ...createInitialState(), tasks: [task], tickets: [active] };
  const result = resolveAndReissueTicket(state, active.id, { kind: "complete" }, now, "next-ticket");
  assert.equal(result.kind, "success");
  assert.equal(result.state.tasks[0].status, "DONE");
  assert.equal(result.state.tasks[0].completedAt, now.toISOString());
  assert.equal(result.state.tickets.find((ticket) => ticket.id === active.id)?.sourceCompleted, true);
  assert.notEqual(getActiveTicket(result.state)?.sourceType, "TASK");
  assert.equal(result.state.tickets.filter((ticket) => ticket.status === "ACTIVE").length, 1);
});

/** A completed block consumes only its minutes until the estimated Task has actually finished. */
test("partial Task completion replans the remaining minutes and finishes only at the total", () => {
  const task = createTask({ estimatedMinutes: 45 });
  const active = createTaskTicket("ACTIVE");
  const state: AppState = { ...createInitialState(), tasks: [task], tickets: [active] };
  const partial = resolveAndReissueTicket(state, active.id, { kind: "complete" }, now, "remaining-task");
  assert.equal(partial.kind, "success");
  assert.equal(partial.state.tasks[0].status, "DOING");
  assert.equal(partial.state.tasks[0].completedMinutes, 30);
  assert.equal(partial.state.tasks[0].completedAt, undefined);
  assert.equal(partial.state.tickets.find((ticket) => ticket.id === active.id)?.sourceCompleted, false);
  assert.equal(getActiveTicket(partial.state)?.sourceId, task.id);
  assert.equal(getActiveTicket(partial.state)?.expectedMinutes, 15);
  const finishedAt = new Date(now.getTime() + 15 * 60_000);
  const finished = resolveAndReissueTicket(partial.state, "remaining-task", { kind: "complete" }, finishedAt, "after-task");
  assert.equal(finished.kind, "success");
  assert.equal(finished.state.tasks[0].status, "DONE");
  assert.equal(finished.state.tasks[0].completedMinutes, 45);
  assert.notEqual(getActiveTicket(finished.state)?.sourceType, "TASK");
  assert.equal(finished.state.tickets.filter((ticket) => ticket.status === "ACTIVE").length, 1);
});

/** Legacy source-linked history repairs storage without counting the same progress a second time. */
test("backup restoration recovers completed Tasks but preserves partially completed Tasks", () => {
  const finished = createTask({ id: "finished", estimatedMinutes: 30 });
  const partial = createTask({ id: "partial", estimatedMinutes: 45, completedMinutes: 30 });
  const state: AppState = {
    ...createInitialState(), tasks: [finished, partial], tickets: [
      createTaskTicket("COMPLETED", { id: "finished-block", sourceId: finished.id, completedAt: now.toISOString() }),
      createTaskTicket("COMPLETED", { id: "partial-block", sourceId: partial.id, completedAt: now.toISOString(), sourceCompleted: false }),
    ],
  };
  const restored = parseStateBackup(JSON.parse(JSON.stringify(createStateBackup(state, now))));
  assert.ok(restored);
  assert.equal(restored.tasks[0].status, "DONE");
  assert.equal(restored.tasks[0].completedMinutes, 30);
  assert.equal(restored.tasks[1].completedMinutes, 30);
  assert.notEqual(restored.tasks[1].status, "DONE");
  const candidate = planNextTicket(createPlannerContext({ tasks: restored.tasks, recentTickets: restored.tickets }));
  assert.equal(candidate.sourceId, partial.id);
  assert.equal(candidate.expectedMinutes, 15);
});

/** A deliberate reopen creates a fresh work cycle while retaining the earlier completion record. */
test("explicitly reopened Tasks ignore previous-cycle completion and keep source types separate", () => {
  const reopenedAt = new Date(now.getTime() + 60_000).toISOString();
  const task = createTask({ estimatedMinutes: 30, reopenedAt });
  const earlier = createTaskTicket("COMPLETED", { completedAt: now.toISOString(), sourceCompleted: true });
  const unrelated = createTaskTicket("COMPLETED", { id: "same-id-schedule", sourceType: "SCHEDULE", sourceCompleted: true });
  const state = normalizeState({ ...createInitialState(), tasks: [task], tickets: [earlier, unrelated] });
  assert.equal(state.tasks[0].status, "TODO");
  assert.equal(state.tasks[0].completedMinutes, 0);
  const candidate = planNextTicket(createPlannerContext({ now: new Date(reopenedAt), tasks: state.tasks, recentTickets: state.tickets }));
  assert.equal(candidate.sourceType, "TASK");
  assert.equal(candidate.sourceId, task.id);
  assert.equal(candidate.expectedMinutes, 30);
});

/** Supplies a fixed schedule fixture whose local occurrence identity does not depend on the host timezone. */
function createCompletionSchedule(overrides: Partial<LocalScheduleItem> = {}): LocalScheduleItem {
  return {
    id: "schedule", title: "병원 방문", type: "appointment",
    startAt: new Date(2026, 9, 6, 10, 0).toISOString(),
    endAt: new Date(2026, 9, 6, 11, 0).toISOString(),
    ...overrides,
  };
}

/** Completing attendance suppresses the original one-off source even if its time window is still open. */
test("completed one-off Schedules are persisted and excluded before immediate replanning", () => {
  const schedule = createCompletionSchedule();
  const context = createPlannerContext({ now: new Date(2026, 9, 6, 10, 5), localSchedule: [schedule] });
  const issued = issueTicket({ ...createInitialState(), localScheduleItems: [schedule] }, planNextTicket(context), context.now, "schedule-active");
  const completedAt = new Date(2026, 9, 6, 10, 10);
  const result = resolveAndReissueTicket(issued.state, "schedule-active", { kind: "complete" }, completedAt, "after-schedule");
  assert.equal(result.kind, "success");
  assert.equal(result.state.localScheduleItems[0].completedAt, completedAt.toISOString());
  const completed = result.state.tickets.find((ticket) => ticket.id === "schedule-active");
  assert.equal(completed?.schedulePhase, "EXECUTION");
  assert.equal(completed?.scheduleOccurrenceStartAt, schedule.startAt);
  assert.equal(completed?.sourceCompleted, true);
  assert.notEqual(getActiveTicket(result.state)?.sourceType, "SCHEDULE");
  const restored = parseStateBackup(JSON.parse(JSON.stringify(createStateBackup(result.state, completedAt))));
  assert.ok(restored);
  const plan = planNextTicketWithDecision({ ...context, localSchedule: restored.localScheduleItems, recentTickets: restored.tickets });
  assert.notEqual(plan.candidate.sourceType, "SCHEDULE");
  assert.ok(plan.decision.candidates.some((candidate) => candidate.sourceId === schedule.id && candidate.disposition === "EXCLUDED"));
  const legacy = normalizeState({
    ...createInitialState(), localScheduleItems: [schedule], tickets: result.state.tickets
      .filter((ticket) => ticket.id === "schedule-active")
      .map((ticket) => ({ ...ticket, sourceCompleted: undefined, schedulePhase: undefined, scheduleOccurrenceStartAt: undefined })),
  });
  assert.equal(legacy.localScheduleItems[0].completedAt, completedAt.toISOString());
  assert.notEqual(planNextTicket({ ...context, localSchedule: legacy.localScheduleItems, recentTickets: legacy.tickets }).sourceType, "SCHEDULE");
});

/** An occurrence is keyed by its original start; daily and weekly templates remain usable on later dates. */
test("recurring Schedule completion blocks only that daily or weekly occurrence", () => {
  for (const frequency of ["DAILY", "WEEKLY"] as const) {
    const schedule = createCompletionSchedule({ recurrence: { frequency, daysOfWeek: [2] } });
    const current = new Date(2026, 9, 6, 10, 5);
    const context = createPlannerContext({ now: current, localSchedule: [schedule] });
    const issued = issueTicket({ ...createInitialState(), localScheduleItems: [schedule] }, planNextTicket(context), current, `recurring-${frequency}`);
    const completed = completeTicket(issued.state, `recurring-${frequency}`, current);
    assert.equal(completed.kind, "success");
    assert.equal(completed.state.localScheduleItems[0].completedAt, undefined);
    assert.deepEqual(completed.state.localScheduleItems[0].completedOccurrenceStarts, [schedule.startAt]);
    const restored = parseStateBackup(JSON.parse(JSON.stringify(createStateBackup(completed.state, current))));
    assert.ok(restored);
    const updated = { ...context, localSchedule: restored.localScheduleItems, recentTickets: restored.tickets };
    assert.notEqual(planNextTicket(updated).sourceType, "SCHEDULE");
    const next = new Date(2026, 9, frequency === "DAILY" ? 7 : 13, 10, 5);
    const candidate = planNextTicket({ ...updated, now: next });
    assert.equal(candidate.sourceType, "SCHEDULE");
    assert.equal(candidate.sourceId, schedule.id);
    assert.equal(candidate.scheduleOccurrenceStartAt, new Date(2026, 9, next.getDate(), 10, 0).toISOString());
  }
});

/** Old attendance directives can recover the start before midnight from the scheduled end, not completion date. */
test("legacy overnight Schedule history suppresses its original occurrence only", () => {
  const schedule = createCompletionSchedule({
    startAt: new Date(2026, 9, 6, 23, 30).toISOString(),
    endAt: new Date(2026, 9, 7, 0, 30).toISOString(), recurrence: { frequency: "DAILY" },
  });
  const completedAt = new Date(2026, 9, 7, 0, 10);
  const legacy = createTaskTicket("COMPLETED", {
    sourceType: "SCHEDULE", sourceId: schedule.id, action: `${schedule.title} 일정에 집중할 것.`,
    createdAt: new Date(2026, 9, 6, 23, 45).toISOString(), deadline: schedule.endAt, completedAt: completedAt.toISOString(),
  });
  const restored = normalizeState({ ...createInitialState(), localScheduleItems: [schedule], tickets: [legacy] });
  assert.deepEqual(restored.localScheduleItems[0].completedOccurrenceStarts, [schedule.startAt]);
  const context = createPlannerContext({ now: completedAt, localSchedule: restored.localScheduleItems, recentTickets: restored.tickets });
  assert.notEqual(planNextTicket(context).sourceType, "SCHEDULE");
  const next = planNextTicket({ ...context, now: new Date(2026, 9, 7, 23, 45) });
  assert.equal(next.sourceType, "SCHEDULE");
  assert.equal(next.scheduleOccurrenceStartAt, new Date(2026, 9, 7, 23, 30).toISOString());
});

/** Preparation completes only its own phase, so attendance remains eligible when its scheduled time arrives. */
test("Schedule preparation is not reissued and does not finish the actual event", () => {
  const schedule = createCompletionSchedule();
  const current = new Date(2026, 9, 6, 9, 50);
  const context = createPlannerContext({ now: current, localSchedule: [schedule] });
  const candidate = planNextTicket(context);
  assert.equal(candidate.schedulePhase, "PREPARATION");
  const issued = issueTicket({ ...createInitialState(), localScheduleItems: [schedule] }, candidate, current, "preparation");
  const completed = completeTicket(issued.state, "preparation", new Date(2026, 9, 6, 9, 55));
  assert.equal(completed.state.localScheduleItems[0].completedAt, undefined);
  assert.equal(completed.state.tickets[0].sourceCompleted, false);
  const updated = { ...context, now: new Date(2026, 9, 6, 9, 55), localSchedule: completed.state.localScheduleItems, recentTickets: completed.state.tickets };
  assert.notEqual(planNextTicket(updated).sourceType, "SCHEDULE");
  const attendance = planNextTicket({ ...updated, now: new Date(2026, 9, 6, 10, 0) });
  assert.equal(attendance.sourceType, "SCHEDULE");
  assert.equal(attendance.schedulePhase, "EXECUTION");
  assert.equal(attendance.scheduleOccurrenceStartAt, schedule.startAt);
});

/** Completion history removes a finished time boundary without confusing identically named source IDs. */
test("completed Schedule boundaries are ignored and sourceType prevents false completion", () => {
  const schedule = createCompletionSchedule({ id: "shared-id" });
  const current = new Date(2026, 9, 6, 9, 40);
  const taskHistory = createTaskTicket("COMPLETED", { sourceId: schedule.id, sourceCompleted: true });
  assert.equal(getAvailableWindow(current, [schedule], [], [taskHistory]), 15);
  const history = createTaskTicket("COMPLETED", {
    sourceType: "SCHEDULE", sourceId: schedule.id, action: `${schedule.title} 일정에 집중할 것.`,
    schedulePhase: "EXECUTION", sourceCompleted: true, scheduleOccurrenceStartAt: schedule.startAt,
  });
  assert.equal(getAvailableWindow(current, [schedule], [], [history]), 120);
  const context = createPlannerContext({ now: new Date(2026, 9, 6, 10, 5), localSchedule: [schedule], recentTickets: [taskHistory] });
  assert.equal(planNextTicket(context).sourceType, "SCHEDULE");
  const completedSource = { ...schedule, completedAt: now.toISOString() };
  assert.notEqual(planNextTicket({ ...context, localSchedule: [completedSource], recentTickets: [] }).sourceType, "SCHEDULE");
});

/** Passing a planned end or reporting failure never creates a whole-source completion marker. */
test("elapsed and failed schedules and accumulated Task minutes are not automatically completed", () => {
  const schedule = createCompletionSchedule();
  const failed = createTaskTicket("FAILED", {
    sourceType: "SCHEDULE", sourceId: schedule.id, failureReason: "time_shortage", completedAt: now.toISOString(),
  });
  const task = createTask({ estimatedMinutes: 30, completedMinutes: 30 });
  const state = normalizeState({ ...createInitialState(), tasks: [task], localScheduleItems: [schedule], tickets: [failed] });
  assert.notEqual(state.tasks[0].status, "DONE");
  assert.equal(state.tasks[0].completedAt, undefined);
  assert.equal(state.localScheduleItems[0].completedAt, undefined);
  const context = createPlannerContext({ now: new Date(2026, 9, 6, 12, 0), localSchedule: state.localScheduleItems, recentTickets: state.tickets });
  planNextTicket(context);
  assert.equal(state.localScheduleItems[0].completedAt, undefined);
  const laterPlan = planNextTicket({ ...context, now: new Date(2026, 9, 6, 10, 10), recentTickets: [] });
  assert.equal(laterPlan.sourceType, "SCHEDULE");
});

/** Expiry derives only from explicit time and does not clear unrelated fatigue or capability restrictions. */
test("User Context activity fatigue and restrictions expire independently", () => {
  const context = { ...createDefaultUserContext(), activity: "OVERTIME" as const, fatigue: "TIRED" as const,
    blockedCapabilities: ["EXERCISE" as const], activityUntil: new Date(2026, 9, 6, 21, 0).toISOString(),
    fatigueUntil: new Date(2026, 9, 6, 23, 0).toISOString(), capabilitiesUntil: new Date(2026, 9, 6, 22, 0).toISOString() };
  const snapshot = JSON.stringify(context);
  const resolved = resolveEffectiveContext(context, new Date(2026, 9, 6, 21, 0));
  assert.equal(resolved.activity, "NORMAL");
  assert.equal(resolved.fatigue, "TIRED");
  assert.deepEqual(resolved.blockedCapabilities, ["EXERCISE"]);
  assert.equal(getNextContextExpiry(resolved, new Date(2026, 9, 6, 21, 0)), context.capabilitiesUntil);
  assert.deepEqual(resolveEffectiveContext(context, new Date(2026, 9, 6, 23, 0)), createDefaultUserContext());
  assert.equal(JSON.stringify(context), snapshot);
});

/** Old and malformed optional data never turns clock-only text into a guessed expiry date. */
test("User Context migration defaults missing values and rejects clock-only expiry", () => {
  assert.deepEqual(normalizeUserContext(undefined), createDefaultUserContext());
  const context = normalizeUserContext({ activity: "constructor", fatigue: "other", activityUntil: "21:00",
    blockedCapabilities: ["EXERCISE", "EXERCISE", "unknown"], capabilitiesUntil: "not-a-date" });
  assert.equal(context.activity, "NORMAL");
  assert.equal(context.fatigue, "NORMAL");
  assert.equal(context.activityUntil, undefined);
  assert.deepEqual(context.blockedCapabilities, ["EXERCISE"]);
});

/** An activity does not infer prohibitions from a title or category; explicit home requirements are different. */
test("outside context filters explicit home requirements but allows unknown requirements", () => {
  const context = createPlannerContext({ userContext: { ...createDefaultUserContext(), activity: "OUTSIDE" },
    tasks: [createTask({ id: "home", importance: 5, executionConstraints: { requiredCapabilities: ["AT_HOME"] } }),
      createTask({ id: "unknown", category: "health", title: "운동", importance: 1 })] });
  const result = evaluatePlanner(context);
  assert.ok(result.kind === "DIRECTIVE");
  assert.equal(result.candidate.sourceId, "unknown");
  assert.ok(result.decision.candidates.some((candidate) => candidate.sourceId === "home" && candidate.disposition === "EXCLUDED"));
  assert.equal(getContextExclusion(undefined, resolveEffectiveContext(context.userContext, context.now)), null);
});

/** UNAVAILABLE is a normal idle result across all source kinds, never a fake System waiting Ticket. */
test("unavailable context defers all actions and persists its decision without ACTIVE", () => {
  const current = new Date(2026, 9, 6, 10, 5);
  const userContext = { ...createDefaultUserContext(), activity: "UNAVAILABLE" as const,
    activityUntil: new Date(2026, 9, 6, 11, 0).toISOString() };
  const state = { ...createInitialState(), userContext, tasks: [createTask()], localScheduleItems: [createCompletionSchedule()] };
  const plan = evaluatePlanner(createPlannerContext({ now: current, userContext, tasks: state.tasks, localSchedule: state.localScheduleItems }));
  assert.equal(plan.kind, "DEFERRED");
  assert.equal(planOptionalTicket(createPlannerContext({ userContext })), null);
  const saved = planAndIssueTicket(state, current, "must-not-exist");
  assert.equal(saved.kind, "success");
  assert.equal(getActiveTicket(saved.state), null);
  assert.equal(saved.state.tickets.length, 0);
  assert.equal(saved.state.plannerDeferral?.resumeAt, userContext.activityUntil);
  assert.equal(saved.state.plannerDeferral?.decision.userContext?.activity, "UNAVAILABLE");
  assert.equal(saved.state.plannerDecisions[0].result, "DEFERRED");
  assert.equal(saved.state.plannerDecisions[0].ticketId, undefined);
  const repeated = planAndIssueTicket(saved.state, new Date(current.getTime() + 60_000), "still-not-issued");
  assert.equal(repeated.state.plannerDecisions.length, saved.state.plannerDecisions.length);
});

/** An empty feasible fallback set cannot be bypassed by the Easter egg or an invented passive instruction. */
test("all context-blocked System fallbacks cause normal deferral", () => {
  const userContext = { ...createDefaultUserContext(), blockedCapabilities: ["EXERCISE" as const] };
  const context = createPlannerContext({ userContext, settings: { ...createInitialState().settings,
    systemFallbacks: [{ id: "exercise-only", action: "운동할 것.", expectedMinutes: 5, executionConstraints: { requiredCapabilities: ["EXERCISE"] } }] } });
  for (let offset = 0; offset < 200; offset += 1) {
    assert.equal(evaluatePlanner({ ...context, now: new Date(context.now.getTime() + offset * 60_000) }).kind, "DEFERRED");
  }
});

/** The current-event and preparation layers cannot outrank a hard execution constraint. */
test("context filtering covers both Schedule execution and preparation", () => {
  const schedule = createCompletionSchedule({ executionConstraints: { blockedActivities: ["OVERTIME"] } });
  for (const current of [new Date(2026, 9, 6, 9, 50), new Date(2026, 9, 6, 10, 5)]) {
    const plan = evaluatePlanner(createPlannerContext({ now: current, localSchedule: [schedule], tasks: [createTask()],
      userContext: { ...createDefaultUserContext(), activity: "OVERTIME" } }));
    assert.ok(plan.kind === "DIRECTIVE");
    assert.equal(plan.candidate.sourceType, "TASK");
    assert.ok(plan.decision.candidates.some((candidate) => candidate.sourceType === "SCHEDULE" && candidate.disposition === "EXCLUDED"));
  }
});

/** A future event remains a time boundary when today's restriction expires before that event begins. */
test("future boundaries use the effective context at their own start time", () => {
  const schedule = createCompletionSchedule({ executionConstraints: { requiredCapabilities: ["AT_HOME"] } });
  const current = new Date(2026, 9, 6, 9, 40);
  const context = { ...createDefaultUserContext(), activity: "OUTSIDE" as const,
    activityUntil: new Date(2026, 9, 6, 9, 50).toISOString() };
  assert.equal(getAvailableWindow(current, [schedule], [], [], context), 15);
  assert.equal(getAvailableWindow(current, [schedule], [], [], { ...context, activityUntil: undefined }), 120);
});

/** Context adjusts continuous work only and records both the original and adjusted block sizes. */
test("fatigue shortens Task blocks deterministically and preserves the audit snapshot", () => {
  for (const [fatigue, expected] of [["TIRED", 15], ["UNWELL", 10]] as const) {
    const context = createPlannerContext({ tasks: [createTask()], userContext: { ...createDefaultUserContext(), fatigue } });
    const plan = evaluatePlanner(context);
    assert.ok(plan.kind === "DIRECTIVE");
    assert.equal(plan.candidate.expectedMinutes, expected);
    assert.match(plan.candidate.action, new RegExp(`${expected}분 동안`));
    const audit = plan.decision.candidates.find((candidate) => candidate.disposition === "SELECTED");
    assert.equal(audit?.originalMinutes, 30);
    assert.equal(audit?.adjustedMinutes, expected);
    assert.equal(plan.decision.userContext?.fatigue, fatigue);
    assert.deepEqual(evaluatePlanner(context), plan);
  }
});

/** A blocked current detailed step cannot be silently skipped to the next step, nor ignore parent constraints. */
test("detailed Routine filters the current step and preserves completion and movement durations", () => {
  const routine = { id: "detailed-context", title: "외출 준비", startTime: "10:00", endTime: "11:00", daysOfWeek: [2],
    category: "personal" as const, priority: 3, enabled: true, timingMode: "FIXED" as const,
    steps: [{ id: "first", title: "장비 준비", actionType: "COMPLETION" as const, expectedMinutes: 20,
      executionConstraints: { requiredCapabilities: ["EQUIPMENT" as const] } },
      { id: "second", title: "귀가", actionType: "MOVEMENT" as const, expectedMinutes: 20 }] };
  const blocked = evaluatePlanner(createPlannerContext({ idealRoutines: [routine], userContext: {
    ...createDefaultUserContext(), blockedCapabilities: ["EQUIPMENT"] } }));
  assert.ok(blocked.kind === "DIRECTIVE");
  assert.notEqual(blocked.candidate.sourceType, "ROUTINE");
  const unwell = evaluatePlanner(createPlannerContext({ idealRoutines: [routine], userContext: { ...createDefaultUserContext(), fatigue: "UNWELL" } }));
  assert.ok(unwell.kind === "DIRECTIVE");
  assert.equal(unwell.candidate.routineStepId, "first");
  assert.equal(unwell.candidate.expectedMinutes, 20);
  const movement = evaluatePlanner(createPlannerContext({ idealRoutines: [{ ...routine, steps: [routine.steps[1]] }],
    userContext: { ...createDefaultUserContext(), fatigue: "UNWELL" } }));
  assert.ok(movement.kind === "DIRECTIVE");
  assert.equal(movement.candidate.expectedMinutes, 20);
  const parentBlocked = evaluatePlanner(createPlannerContext({ idealRoutines: [{ ...routine,
    executionConstraints: { blockedActivities: ["OUTSIDE"] } }],
    userContext: { ...createDefaultUserContext(), activity: "OUTSIDE" } }));
  assert.ok(parentBlocked.kind === "DIRECTIVE");
  assert.notEqual(parentBlocked.candidate.sourceType, "ROUTINE");
});

/** Unwell excludes only explicitly high-effort actions rather than guessing from category or task title. */
test("unwell excludes explicit high effort while overtime requires an explicit activity restriction", () => {
  const high = createTask({ id: "high", executionConstraints: { effort: "HIGH" } });
  const normal = createTask({ id: "normal", importance: 1 });
  const plan = evaluatePlanner(createPlannerContext({ tasks: [high, normal], userContext: { ...createDefaultUserContext(), fatigue: "UNWELL" } }));
  assert.ok(plan.kind === "DIRECTIVE");
  assert.equal(plan.candidate.sourceId, normal.id);
  assert.equal(planNextTicket(createPlannerContext({ tasks: [high], userContext: { ...createDefaultUserContext(), activity: "OVERTIME" } })).sourceId, high.id);
});

/** Saving a conflicting state preserves ACTIVE; only a separate confirmation records context cancellation. */
test("context save preserves ACTIVE and confirmed cancellation does not count failure or progress", () => {
  const active = createTaskTicket("ACTIVE");
  const state = { ...createInitialState(), tasks: [createTask()], tickets: [active] };
  const context = { ...createDefaultUserContext(), activity: "UNAVAILABLE" as const };
  const saved = saveUserContextState(state, context, now, "no-new-ticket");
  assert.equal(getActiveTicket(saved.state)?.id, active.id);
  assert.equal(saved.state.tickets.length, 1);
  const cancelled = replanForUserContext(saved.state, active.id, now, "must-defer");
  assert.equal(cancelled.kind, "success");
  assert.equal(getActiveTicket(cancelled.state), null);
  const history = cancelled.state.tickets[0];
  assert.equal(history.status, "CANCELLED");
  assert.equal(history.cancellationReason, "CONTEXT_CHANGED");
  assert.equal(history.cancelledAt, now.toISOString());
  assert.equal(history.failureReason, undefined);
  assert.equal(history.completedAt, undefined);
  assert.equal(history.invalidReason, undefined);
  assert.equal(cancelled.state.tasks[0].completedMinutes, 0);
  assert.ok(cancelled.state.plannerDeferral);
});

/** Confirmation cannot cancel a replacement ACTIVE or a directive whose restriction has already expired. */
test("stale context confirmation never cancels a different or newly valid ACTIVE", () => {
  const active = createTaskTicket("ACTIVE", { id: "replacement" });
  const state = { ...createInitialState(), tickets: [active], userContext: { ...createDefaultUserContext(), activity: "UNAVAILABLE" as const,
    activityUntil: new Date(now.getTime() + 60_000).toISOString() } };
  assert.equal(replanForUserContext(state, "old-ticket", now, "next").kind, "conflict");
  assert.equal(replanForUserContext(state, active.id, new Date(now.getTime() + 60_000), "next").kind, "conflict");
  assert.equal(getActiveTicket(state)?.id, active.id);
});

/** Explicit completion is still saved while unavailable, but it does not force a replacement ACTIVE. */
test("completion while unavailable saves source and history then normally defers", () => {
  const state = { ...createInitialState(), tasks: [createTask({ estimatedMinutes: 30 })], tickets: [createTaskTicket("ACTIVE")],
    userContext: { ...createDefaultUserContext(), activity: "UNAVAILABLE" as const } };
  const result = resolveAndReissueTicket(state, "ticket", { kind: "complete" }, now, "no-replacement");
  assert.equal(result.kind, "success");
  assert.equal(result.state.tasks[0].status, "DONE");
  assert.equal(result.state.tickets[0].status, "COMPLETED");
  assert.equal(getActiveTicket(result.state), null);
  assert.ok(result.state.plannerDeferral);
});

/** Optional context and constraints survive storage restoration, and expiry can resume from saved DEFERRED state. */
test("context backup round trip preserves requirements and resumes normally after expiry", () => {
  const context = { ...createDefaultUserContext(), activity: "UNAVAILABLE" as const, activityUntil: new Date(now.getTime() + 60_000).toISOString(),
    fatigue: "TIRED" as const, fatigueUntil: new Date(now.getTime() + 3_600_000).toISOString() };
  const task = createTask({ executionConstraints: { requiredCapabilities: ["FOCUS"], blockedActivities: ["OVERTIME"], effort: "NORMAL" } });
  const deferred = planAndIssueTicket({ ...createInitialState(), userContext: context, tasks: [task] }, now, "not-issued");
  const restored = parseStateBackup(JSON.parse(JSON.stringify(createStateBackup(deferred.state, now))));
  assert.ok(restored);
  assert.deepEqual(restored.userContext, context);
  assert.deepEqual(restored.tasks[0].executionConstraints, task.executionConstraints);
  assert.equal(restored.plannerDeferral?.decision.result, "DEFERRED");
  const resumed = planAndIssueTicket(restored, new Date(now.getTime() + 60_000), "resumed");
  assert.equal(getActiveTicket(resumed.state)?.sourceType, "TASK");
  assert.equal(getActiveTicket(resumed.state)?.expectedMinutes, 15);
  assert.equal(resumed.state.plannerDeferral, undefined);
  assert.equal(resumed.state.plannerDecisions[1].result, "DEFERRED");
  assert.equal(resumed.state.tickets.filter((ticket) => ticket.status === "ACTIVE").length, 1);
});

/** An issued snapshot still explains a conflict even if its original source was deleted after issuance. */
test("ACTIVE context conflicts retain their issued execution constraint snapshot", () => {
  const active = createTaskTicket("ACTIVE", { executionConstraints: { requiredCapabilities: ["AT_HOME"] } });
  const state = { ...createInitialState(), tickets: [active], userContext: { ...createDefaultUserContext(), activity: "OUTSIDE" as const } };
  assert.match(getActiveContextConflict(state, active, now) ?? "", /집에서 수행/);
});

/** A newly issued overdue Task displays this execution block's end, not yesterday's original due date. */
test("overdue Task timing uses its current execution window without changing the original deadline", () => {
  const issuedAt = new Date(2026, 9, 15, 17, 25);
  const originalDeadline = new Date(2026, 9, 14, 10, 56).toISOString();
  const ticket = createTaskTicket("ACTIVE", { createdAt: issuedAt.toISOString(), deadline: originalDeadline });
  const snapshot = JSON.stringify(ticket);
  assert.equal(getDirectiveDisplayDeadline(ticket)?.toISOString(), new Date(2026, 9, 15, 17, 55).toISOString());
  assert.match(formatDirectiveTiming(ticket), /10월\s*15일\s*17:55까지/);
  assert.equal(getOverdueTaskDeadline(ticket)?.toISOString(), originalDeadline);
  assert.equal(JSON.stringify(ticket), snapshot);
});

/** The local start day, midnight crossing and acknowledged continuation determine execution-end display. */
test("overdue Task timing respects midnight and continue extensions", () => {
  const ticket = createTaskTicket("ACTIVE", { createdAt: new Date(2026, 9, 15, 23, 50).toISOString(),
    deadline: new Date(2026, 9, 14, 10, 56).toISOString(), expectedMinutes: 30 });
  assert.equal(getDirectiveDisplayDeadline(ticket)?.toISOString(), new Date(2026, 9, 16, 0, 20).toISOString());
  const extendedUntil = new Date(2026, 9, 16, 0, 40).toISOString();
  assert.equal(getDirectiveDisplayDeadline({ ...ticket, extendedUntil })?.toISOString(), extendedUntil);
});

/** Future user deadlines and fixed occurrence deadlines retain their original semantics. */
test("future Task deadlines and Schedule or Routine timing remain unchanged", () => {
  const issuedAt = new Date(2026, 9, 15, 17, 25).toISOString();
  const future = new Date(2026, 9, 16, 10, 56).toISOString();
  assert.equal(getDirectiveDisplayDeadline(createTaskTicket("ACTIVE", { createdAt: issuedAt, deadline: future }))?.toISOString(), future);
  const past = new Date(2026, 9, 14, 10, 56).toISOString();
  for (const sourceType of ["SCHEDULE", "ROUTINE"] as const) {
    const ticket = createTaskTicket("ACTIVE", { sourceType, createdAt: issuedAt, deadline: past });
    assert.equal(getDirectiveDisplayDeadline(ticket)?.toISOString(), past);
    assert.equal(getOverdueTaskDeadline(ticket), null);
  }
});

/** Formatting does not hide a genuinely old ACTIVE by substituting the current wall clock. */
test("old ACTIVE timing stays tied to issuance rather than moving its deadline forward", () => {
  const ticket = createTaskTicket("ACTIVE", { createdAt: new Date(2026, 9, 14, 17, 25).toISOString(),
    deadline: new Date(2026, 9, 13, 10, 56).toISOString() });
  assert.equal(getDirectiveDisplayDeadline(ticket)?.toISOString(), new Date(2026, 9, 14, 17, 55).toISOString());
  assert.ok(getActiveTicketStaleness(ticket, new Date(2026, 9, 15, 17, 25)));
});

/** Missing or corrupt dates preserve the stable start prompt; waiting and unlimited actions keep their special lines. */
test("directive timing retains undated fallback waiting and unlimited behavior", () => {
  const ticket = createTaskTicket("ACTIVE", { deadline: null });
  assert.match(formatDirectiveTiming(ticket), /^(?:[7-9]|1[0-5])분 이내에$/);
  assert.equal(formatDirectiveTiming(ticket), formatDirectiveTiming(ticket));
  assert.match(formatDirectiveTiming({ ...ticket, deadline: "not-a-date" }), /분 이내에$/);
  assert.equal(formatDirectiveTiming({ ...ticket, sourceType: "SYSTEM", sourceId: "system:wait-for-schedule", expectedMinutes: 12 }), "12분 동안");
  assert.equal(formatDirectiveTiming({ ...ticket, sourceType: "SYSTEM", sourceId: happinessEasterEggSourceId }), "");
});

/** Keeps continuation separate from completion and extends only the expected-end reminder. */
test("continuing an overdue directive preserves ACTIVE and extends its reminder", () => {
  const ticket = createTaskTicket("ACTIVE", { createdAt: new Date(2026, 9, 6, 10, 0).toISOString(), expectedMinutes: 30 });
  const state: AppState = { ...createInitialState(), tickets: [ticket] };
  const continued = continueTicket(state, ticket.id, new Date(2026, 9, 6, 10, 35), 10);
  assert.equal(getActiveTicket(continued.state)?.id, ticket.id);
  assert.equal(getTicketExpectedEndAt(continued.state.tickets[0]).toISOString(), new Date(2026, 9, 6, 10, 45).toISOString());
  assert.equal(continued.state.tickets[0].completedAt, undefined);
});

/** Warns for ordinary and week-wrapping overlaps while keeping non-overlapping routines clear. */
test("routine overlap detection covers overnight weekly boundaries", () => {
  const sundayNight = {
    id: "sunday-night", title: "취침", startTime: "23:30", endTime: "01:00",
    daysOfWeek: [0], category: "sleep" as const, priority: 4, enabled: true, timingMode: "FIXED" as const,
  };
  const mondayMorning = {
    title: "기상 준비", startTime: "00:30", endTime: "01:30",
    daysOfWeek: [1], category: "personal" as const, priority: 3, enabled: true, timingMode: "FLEXIBLE" as const,
  };
  assert.deepEqual(getRoutineOverlapConflicts([sundayNight], mondayMorning).map(({ routine }) => routine.id), ["sunday-night"]);
  assert.equal(getRoutineOverlapConflicts([sundayNight], { ...mondayMorning, startTime: "02:00" }).length, 0);
});

/** Uses only FIXED routine starts as shared available-time boundaries. */
test("flexible routine starts do not shorten the available Planner window", () => {
  const routine = {
    id: "evening", title: "저녁 운동", startTime: "20:00", endTime: "21:00",
    daysOfWeek: [2], category: "exercise" as const, priority: 3, enabled: true,
  };
  const current = new Date(2026, 9, 6, 19, 40);
  assert.equal(getAvailableWindow(current, [], [{ ...routine, timingMode: "FIXED" }]), 15);
  assert.equal(getAvailableWindow(current, [], [{ ...routine, timingMode: "FLEXIBLE" }]), 120);
});

/** Keeps long duration-step fixtures stable and separate from the ordinary Task source. */
function createDetailedRoutine(overrides: Partial<IdealRoutine> = {}): IdealRoutine {
  return {
    id: "progressRoutine", title: "학습 루틴", startTime: "10:00", endTime: "13:00",
    daysOfWeek: [2, 3], category: "study", priority: 3, enabled: true, timingMode: "FIXED",
    steps: [{ id: "study", title: "공부", actionType: "DURATION", expectedMinutes: 60 },
      { id: "finish", title: "책상 정리", actionType: "COMPLETION", expectedMinutes: 5 }],
    ...overrides,
  };
}

/** Finishes tiny remainders without relaxing the minimum real available-time rule. */
test("Task remainders of one through four minutes can finish and persist as DONE", () => {
  const current = new Date(2026, 9, 6, 10, 0);
  for (const remaining of [1, 2, 3, 4]) {
    const task = createTask({ estimatedMinutes: 35, completedMinutes: 35 - remaining, status: "DOING" });
    const initial = { ...createInitialState(), tasks: [task] };
    const issued = planAndIssueTicket(initial, current, `last${remaining}`);
    const active = getActiveTicket(issued.state);
    assert.ok(active);
    assert.equal(active.sourceType, "TASK");
    assert.equal(active.expectedMinutes, remaining);
    const completed = resolveAndReissueTicket(issued.state, active.id, { kind: "complete" },
      new Date(current.getTime() + remaining * 60_000), `next${remaining}`);
    assert.equal(completed.kind, "success");
    assert.equal(completed.state.tasks[0].status, "DONE");
    assert.equal(completed.state.tasks[0].completedMinutes, 35);
    assert.equal(completed.state.tickets.find((ticket) => ticket.id === active.id)?.sourceCompleted, true);
    assert.equal(completed.state.tickets.filter((ticket) => ticket.status === "ACTIVE").length, 1);
    assert.notEqual(getActiveTicket(completed.state)?.sourceType, "TASK");
    const restored = parseStateBackup(JSON.parse(JSON.stringify(createStateBackup(completed.state, current))));
    assert.equal(restored?.tasks[0].status, "DONE");
    assert.equal(initial.tasks[0].status, "DOING");
  }
});

/** A short remainder needs five free minutes; an empty Task never produces a zero-minute directive. */
test("tiny Task blocks respect the four versus five minute availability boundary", () => {
  const context = createPlannerContext({ tasks: [createTask({ estimatedMinutes: 35, completedMinutes: 34 })] });
  const future = createDetailedRoutine({ id: "futureRoutine", startTime: "10:10", endTime: "11:00", steps: [] });
  assert.equal(getAvailableWindow(context.now, [], [future]), 5);
  const allowed = planNextTicket({ ...context, idealRoutines: [future] });
  assert.equal(allowed.sourceType, "TASK");
  assert.equal(allowed.expectedMinutes, 1);
  const earlier = { ...future, startTime: "10:09" };
  assert.equal(getAvailableWindow(context.now, [], [earlier]), 4);
  assert.notEqual(planNextTicket({ ...context, idealRoutines: [earlier] }).sourceType, "TASK");
  assert.notEqual(planNextTicket({ ...context, tasks: [createTask({ estimatedMinutes: 35, completedMinutes: 35 })] }).sourceType, "TASK");
});

/** Two completed 30-minute blocks finish a 60-minute step without exposing or skipping the next action. */
test("detailed duration Routine advances only after its whole target is completed", () => {
  const current = new Date(2026, 9, 6, 10, 0);
  const routine = createDetailedRoutine();
  const initial = { ...createInitialState(), idealRoutines: [routine] };
  const first = planAndIssueTicket(initial, current, "firstBlock");
  const active = getActiveTicket(first.state);
  assert.ok(active);
  assert.equal(active.routineStepId, "study");
  assert.equal(active.expectedMinutes, 30);
  assert.equal(active.routineOccurrenceStartAt, current.toISOString());
  const second = resolveAndReissueTicket(first.state, active.id, { kind: "complete" }, new Date(2026, 9, 6, 10, 30), "secondBlock");
  assert.equal(second.state.tickets.find((ticket) => ticket.id === "firstBlock")?.routineStepCompleted, false);
  assert.equal(getActiveTicket(second.state)?.routineStepId, "study");
  assert.equal(getActiveTicket(second.state)?.expectedMinutes, 30);
  assert.match(getActiveTicket(second.state)?.selectionReason ?? "", /누적 30\/60분.*남은 30분/);
  const third = resolveAndReissueTicket(second.state, "secondBlock", { kind: "complete" }, new Date(2026, 9, 6, 11, 0), "nextStep");
  assert.equal(third.state.tickets.find((ticket) => ticket.id === "secondBlock")?.routineStepCompleted, true);
  assert.equal(getActiveTicket(third.state)?.routineStepId, "finish");
  const done = resolveAndReissueTicket(third.state, "nextStep", { kind: "complete" }, new Date(2026, 9, 6, 11, 5), "fallback");
  assert.notEqual(getActiveTicket(done.state)?.sourceType, "ROUTINE");
  for (const result of [first, second, third, done]) {
    assert.equal(result.kind, "success");
    assert.equal(result.state.tickets.filter((ticket) => ticket.status === "ACTIVE").length, 1);
  }
  assert.equal(initial.tickets.length, 0);
  assert.equal(planAndIssueTicket(first.state, current, "duplicate").kind, "conflict");
});

/** Fatigue reductions consume only each completed block and retain even the small final remainder. */
test("fatigue-shortened Routine blocks accumulate until the target rather than skipping the step", () => {
  for (const [fatigue, blocks] of [["TIRED", [15, 15, 5]], ["UNWELL", [10, 10, 10, 5]]] as const) {
    const routine = createDetailedRoutine({ steps: [{ id: "study", title: "공부", actionType: "DURATION", expectedMinutes: 35 }] });
    let current = new Date(2026, 9, 6, 10, 0);
    let state: AppState = { ...createInitialState(), idealRoutines: [routine], userContext: { ...createDefaultUserContext(), fatigue } };
    state = planAndIssueTicket(state, current, "block0").state;
    for (const [index, minutes] of blocks.entries()) {
      const active = getActiveTicket(state);
      assert.ok(active);
      assert.equal(active.routineStepId, "study");
      assert.equal(active.expectedMinutes, minutes);
      current = new Date(current.getTime() + minutes * 60_000);
      state = resolveAndReissueTicket(state, active.id, { kind: "complete" }, current, `block${index + 1}`).state;
      assert.equal(state.tickets.find((ticket) => ticket.id === active.id)?.routineStepCompleted, index === blocks.length - 1);
      assert.equal(state.tickets.filter((ticket) => ticket.status === "ACTIVE").length, 1);
    }
    assert.notEqual(getActiveTicket(state)?.sourceType, "ROUTINE");
    const window = getRoutineWindow(routine, current);
    assert.ok(window);
    assert.equal(getRoutineStepProgress(routine, routine.steps![0], window, state.tickets).completedMinutes, 35);
  }
});

/** The final one-through-four-minute duration remainder is still a real unfinished step. */
test("detailed Routine emits a tiny final block instead of dropping or overshooting it", () => {
  for (const remaining of [1, 2, 3, 4]) {
    const routine = createDetailedRoutine({ steps: [{ id: "study", title: "공부", actionType: "DURATION", expectedMinutes: 30 + remaining }] });
    const initial = { ...createInitialState(), idealRoutines: [routine] };
    const issued = planAndIssueTicket(initial, new Date(2026, 9, 6, 10, 0), "firstBlock");
    const resumed = resolveAndReissueTicket(issued.state, "firstBlock", { kind: "complete" }, new Date(2026, 9, 6, 10, 30), "lastBlock");
    assert.equal(getActiveTicket(resumed.state)?.routineStepId, "study");
    assert.equal(getActiveTicket(resumed.state)?.expectedMinutes, remaining);
    const completed = completeTicket(resumed.state, "lastBlock", new Date(2026, 9, 6, 10, 30 + remaining));
    assert.equal(completed.state.tickets.find((ticket) => ticket.id === "lastBlock")?.routineStepCompleted, true);
  }
});

/** Failure shrinkage retains prior successful work without counting the failed block itself. */
test("failed Routine block retries remaining work in shorter blocks without losing prior progress", () => {
  const initial = { ...createInitialState(), idealRoutines: [createDetailedRoutine()] };
  const first = planAndIssueTicket(initial, new Date(2026, 9, 6, 10, 0), "firstBlock");
  const second = resolveAndReissueTicket(first.state, "firstBlock", { kind: "complete" }, new Date(2026, 9, 6, 10, 30), "failedBlock");
  const retry = resolveAndReissueTicket(second.state, "failedBlock", { kind: "fail", reason: "time_shortage" }, new Date(2026, 9, 6, 10, 40), "retryBlock");
  assert.equal(getActiveTicket(retry.state)?.routineStepId, "study");
  assert.equal(getActiveTicket(retry.state)?.expectedMinutes, 15);
  assert.match(getActiveTicket(retry.state)?.selectionReason ?? "", /누적 30\/60분.*남은 30분/);
  const last = resolveAndReissueTicket(retry.state, "retryBlock", { kind: "complete" }, new Date(2026, 9, 6, 10, 55), "lastBlock");
  assert.equal(getActiveTicket(last.state)?.routineStepId, "study");
  assert.equal(getActiveTicket(last.state)?.expectedMinutes, 15);
  const done = resolveAndReissueTicket(last.state, "lastBlock", { kind: "complete" }, new Date(2026, 9, 6, 11, 10), "nextStep");
  assert.equal(getActiveTicket(done.state)?.routineStepId, "finish");
  assert.equal(done.state.tickets.filter((ticket) => ticket.status === "FAILED").length, 1);
  assert.equal(done.state.tickets.find((ticket) => ticket.id === "lastBlock")?.routineStepCompleted, true);
});

/** A boundary-shortened block leaves the remainder intact after the intervening fixed routine ends. */
test("available-time truncation of a Routine does not complete the full detailed step", () => {
  const routine = createDetailedRoutine();
  const boundary = createDetailedRoutine({ id: "boundary", startTime: "10:20", endTime: "10:40", steps: [], priority: 1 });
  const initial = { ...createInitialState(), idealRoutines: [routine, boundary] };
  const first = planAndIssueTicket(initial, new Date(2026, 9, 6, 10, 0), "shortBlock");
  assert.equal(getActiveTicket(first.state)?.expectedMinutes, 15);
  const completed = completeTicket(first.state, "shortBlock", new Date(2026, 9, 6, 10, 15));
  assert.equal(completed.state.tickets[0].routineStepCompleted, false);
  const resumed = planAndIssueTicket(completed.state, new Date(2026, 9, 6, 10, 45), "resumed");
  assert.equal(getActiveTicket(resumed.state)?.routineStepId, "study");
  assert.equal(getActiveTicket(resumed.state)?.expectedMinutes, 30);
  assert.match(getActiveTicket(resumed.state)?.selectionReason ?? "", /누적 15\/60분.*남은 45분/);
});

/** Only successful blocks of the same source, step and original occurrence can contribute work. */
test("Routine progress excludes failures invalid cancellations other sources and other occurrences", () => {
  const routine = createDetailedRoutine();
  const window = getRoutineWindow(routine, new Date(2026, 9, 6, 10, 0));
  assert.ok(window);
  const base = createTaskTicket("COMPLETED", { sourceType: "ROUTINE", sourceId: routine.id, routineStepId: "study",
    createdAt: window.startAt.toISOString(), expectedMinutes: 12, routineOccurrenceStartAt: window.startAt.toISOString(),
    routineOccurrenceEndAt: window.endAt.toISOString() });
  const ignored: Ticket[] = [
    ...(["FAILED", "INVALID", "CANCELLED", "ACTIVE"] as const).map((status) => ({ ...base, status })),
    { ...base, sourceType: "TASK" }, { ...base, sourceId: "otherRoutine" }, { ...base, routineStepId: "finish" },
    { ...base, routineOccurrenceStartAt: new Date(2026, 9, 7, 10, 0).toISOString() },
    { ...base, routineOccurrenceStartAt: undefined, createdAt: new Date(2026, 9, 5, 10, 0).toISOString() },
  ];
  const tickets = [base, ...ignored];
  const snapshot = JSON.stringify(tickets);
  assert.deepEqual(getRoutineStepProgress(routine, routine.steps![0], window, tickets), {
    targetMinutes: 60, completedMinutes: 12, remainingMinutes: 48, isCompleted: false,
  });
  assert.deepEqual(getRoutineStepProgress(routine, routine.steps![0], window, [...tickets].reverse()),
    getRoutineStepProgress(routine, routine.steps![0], window, tickets));
  assert.equal(JSON.stringify(tickets), snapshot);
});

/** Completion and movement describe completed actions, not mandatory accumulated duration. */
test("non-duration Routine steps still finish with one completion report", () => {
  for (const actionType of ["COMPLETION", "MOVEMENT"] as const) {
    const routine = createDetailedRoutine({ steps: [{ id: "action", title: "귀가", actionType, expectedMinutes: 60 }] });
    const current = new Date(2026, 9, 6, 10, 0);
    const issued = planAndIssueTicket({ ...createInitialState(), idealRoutines: [routine] }, current, "oneAction");
    assert.equal(getActiveTicket(issued.state)?.expectedMinutes, 30);
    const completed = resolveAndReissueTicket(issued.state, "oneAction", { kind: "complete" }, new Date(2026, 9, 6, 10, 30), "afterAction");
    assert.equal(completed.state.tickets.find((ticket) => ticket.id === "oneAction")?.routineStepCompleted, true);
    assert.notEqual(getActiveTicket(completed.state)?.sourceType, "ROUTINE");
  }
});

/** Backups keep partial blocks and original occurrence fields; template data is never mutated. */
test("Routine partial progress survives backup restoration without leaking into the next day", () => {
  const routine = createDetailedRoutine();
  const current = new Date(2026, 9, 6, 10, 0);
  const initial = { ...createInitialState(), idealRoutines: [routine] };
  const snapshot = JSON.stringify(initial);
  const issued = planAndIssueTicket(initial, current, "firstBlock");
  const completed = completeTicket(issued.state, "firstBlock", new Date(2026, 9, 6, 10, 30));
  const restored = parseStateBackup(JSON.parse(JSON.stringify(createStateBackup(completed.state, current))));
  assert.ok(restored);
  assert.equal(restored.tickets[0].routineStepCompleted, false);
  assert.equal(restored.tickets[0].routineOccurrenceStartAt, current.toISOString());
  const sameDay = planAndIssueTicket(restored, new Date(2026, 9, 6, 10, 30), "sameDay");
  assert.equal(getActiveTicket(sameDay.state)?.expectedMinutes, 30);
  assert.equal(getActiveTicket(sameDay.state)?.routineStepId, "study");
  const nextDay = planAndIssueTicket(restored, new Date(2026, 9, 7, 10, 0), "nextDay");
  assert.equal(getActiveTicket(nextDay.state)?.routineStepId, "study");
  assert.match(getActiveTicket(nextDay.state)?.selectionReason ?? "", /누적 0\/60분.*남은 60분/);
  assert.equal(JSON.stringify(initial), snapshot);
});

/** Midnight and late reports continue to refer to the original issuing occurrence. */
test("overnight Routine blocks retain occurrence identity even when reported after the window", () => {
  const routine = createDetailedRoutine({ startTime: "23:30", endTime: "01:30" });
  const initial = { ...createInitialState(), idealRoutines: [routine] };
  const issued = planAndIssueTicket(initial, new Date(2026, 9, 6, 23, 45), "nightBlock");
  const originalStart = new Date(2026, 9, 6, 23, 30).toISOString();
  const midnight = resolveAndReissueTicket(issued.state, "nightBlock", { kind: "complete" }, new Date(2026, 9, 7, 0, 15), "afterMidnight");
  assert.equal(getActiveTicket(midnight.state)?.routineStepId, "study");
  assert.equal(getActiveTicket(midnight.state)?.expectedMinutes, 30);
  assert.equal(getActiveTicket(midnight.state)?.routineOccurrenceStartAt, originalStart);
  const late = completeTicket(issued.state, "nightBlock", new Date(2026, 9, 7, 2, 0));
  assert.equal(late.state.tickets[0].routineOccurrenceStartAt, originalStart);
  assert.equal(late.state.tickets[0].routineStepCompleted, false);
  const nextNight = planAndIssueTicket(late.state, new Date(2026, 9, 7, 23, 45), "nextNight");
  assert.match(getActiveTicket(nextNight.state)?.selectionReason ?? "", /누적 0\/60분/);
});

/** Existing histories recover progress from issue time rather than treating a partial block as a full step. */
test("legacy Routine blocks without occurrence metadata preserve remaining work", () => {
  const routine = createDetailedRoutine({ startTime: "23:30", endTime: "01:30" });
  const legacy = createTaskTicket("COMPLETED", { sourceType: "ROUTINE", sourceId: routine.id, routineStepId: "study",
    createdAt: new Date(2026, 9, 6, 23, 45).toISOString(), completedAt: new Date(2026, 9, 7, 0, 15).toISOString() });
  const window = getRoutineTicketWindow(routine, legacy);
  assert.ok(window);
  assert.equal(window.startAt.toISOString(), new Date(2026, 9, 6, 23, 30).toISOString());
  const step = getCurrentRoutineStep(routine, window, [legacy]);
  assert.equal(step?.step.id, "study");
  assert.equal(step?.progress.remainingMinutes, 30);
  const candidate = planNextTicket(createPlannerContext({ now: new Date(2026, 9, 7, 0, 30), idealRoutines: [routine], recentTickets: [legacy] }));
  assert.equal(candidate.routineStepId, "study");
  assert.equal(candidate.expectedMinutes, 30);
});

/** Extending a confirmation reminder does not fabricate additional completed Routine work. */
test("continuing a Routine reminder does not increase its completed duration", () => {
  const routine = createDetailedRoutine();
  const current = new Date(2026, 9, 6, 10, 0);
  const issued = planAndIssueTicket({ ...createInitialState(), idealRoutines: [routine] }, current, "continuedBlock");
  const extended = continueTicket(issued.state, "continuedBlock", new Date(2026, 9, 6, 10, 30), 20);
  const completed = completeTicket(extended.state, "continuedBlock", new Date(2026, 9, 6, 10, 50));
  const window = getRoutineWindow(routine, current);
  assert.ok(window);
  assert.equal(getRoutineStepProgress(routine, routine.steps![0], window, completed.state.tickets).completedMinutes, 30);
  assert.equal(completed.state.tickets[0].routineStepCompleted, false);
});
