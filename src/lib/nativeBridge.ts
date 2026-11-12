import { Capacitor, registerPlugin } from "@capacitor/core";
import {
  LocalNotifications,
  type LocalNotificationSchema,
  type PendingLocalNotificationSchema,
} from "@capacitor/local-notifications";
import { getRoutineOccurrences, type RoutineOccurrence } from "./calendar";
import { getActiveTicket, getTicketExpectedEndAt, isUnlimitedDurationTicket, type AppState, type IdealRoutine } from "./ticketMachine";
import { createCalendarWidgetDays } from "./calendarWidget";
import { calendarWidgetBridge } from "./calendarWidgetBridge";
import {
  createAndroidNotificationChannel,
  getNotificationSoundOptions,
  notificationChannelId,
} from "./notificationSound";

interface DirectiveWidgetPlugin {
  sync(options: { recipient: string; trigger: string; action: string; deadline: string }): Promise<void>;
}

export interface NativeExperienceSyncOptions {
  /** The ACTIVE ticket created by the state transition that triggered this synchronization. */
  issuedTicketId?: string;
  /** Cancels and recreates managed reservations from the latest state. */
  forceNotificationResync?: boolean;
}

interface LocalNotificationSyncOptions extends NativeExperienceSyncOptions {
  /** Whether the app was visible when the ACTIVE directive transition was observed. */
  suppressIssuedNotification?: boolean;
}

export interface NotificationPermissionSnapshot {
  isNative: boolean;
  platform: string;
  display: "granted" | "denied" | "prompt" | "prompt-with-rationale" | "unavailable";
  exactAlarm: "granted" | "denied" | "prompt" | "prompt-with-rationale" | "unavailable" | "not-applicable";
}

export interface RoutineNotificationAction {
  routineId: string;
  startAt: string;
}

export interface NotificationDiagnostics {
  permission: NotificationPermissionSnapshot;
  pendingCount: number;
  nextNotificationAt?: string;
  nextNotificationKind?: string;
}

interface NotificationSyncReceipt {
  lastIssuedTicketId?: string;
  endReminderTicketIds: string[];
  routineAnnouncementKeys: string[];
}

type NotificationPermissionValue = NotificationPermissionSnapshot["display"];

const DirectiveWidget = registerPlugin<DirectiveWidgetPlugin>("DirectiveWidget");
const notificationOwner = "directive-terminal";
const notificationReceiptKey = "directiveNotificationSyncV2";
const notificationHorizonDays = 7;
const foregroundRoutineCancellationGraceMs = 1_000;
const receiptHistoryLimit = 100;
let nativeSyncQueue: Promise<void> = Promise.resolve();

/** Reports whether the app document is visible when a native synchronization request begins. */
function isAppVisible(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "visible";
}

/** Creates a stable positive Android notification identifier from arbitrary text. */
function createNotificationId(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) | 0;
  return 1_000 + (Math.abs(hash) % 2_000_000_000);
}

/** Creates a stable identity shared by a scheduled routine alert and its foreground cancellation. */
function createRoutineOccurrenceKey(routineId: string, startAt: Date): string {
  return `${routineId}:${startAt.toISOString()}`;
}

/** Reads bounded delivery metadata without adding notification concerns to AppState or backups. */
function readNotificationReceipt(): NotificationSyncReceipt {
  const empty: NotificationSyncReceipt = { endReminderTicketIds: [], routineAnnouncementKeys: [] };
  if (typeof window === "undefined") return empty;
  try {
    const decoded = JSON.parse(window.localStorage.getItem(notificationReceiptKey) ?? "null") as unknown;
    if (!decoded || typeof decoded !== "object") return empty;
    const record = decoded as Record<string, unknown>;
    return {
      lastIssuedTicketId: typeof record.lastIssuedTicketId === "string" ? record.lastIssuedTicketId : undefined,
      endReminderTicketIds: Array.isArray(record.endReminderTicketIds)
        ? record.endReminderTicketIds.filter((value): value is string => typeof value === "string").slice(-receiptHistoryLimit)
        : [],
      routineAnnouncementKeys: Array.isArray(record.routineAnnouncementKeys)
        ? record.routineAnnouncementKeys.filter((value): value is string => typeof value === "string").slice(-receiptHistoryLimit)
        : [],
    };
  } catch {
    return empty;
  }
}

/** Persists bounded notification delivery metadata after the native scheduler accepts a request. */
function writeNotificationReceipt(receipt: NotificationSyncReceipt): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(notificationReceiptKey, JSON.stringify({
    ...receipt,
    endReminderTicketIds: receipt.endReminderTicketIds.slice(-receiptHistoryLimit),
    routineAnnouncementKeys: receipt.routineAnnouncementKeys.slice(-receiptHistoryLimit),
  }));
}

/** Converts plugin permission strings into a stable settings-facing value. */
function normalizePermission(value: string | undefined): NotificationPermissionValue {
  if (value === "granted" || value === "denied" || value === "prompt" || value === "prompt-with-rationale") return value;
  return "unavailable";
}

/** Returns current notification and Android exact-alarm access without opening a system prompt. */
export async function getNotificationPermissionSnapshot(): Promise<NotificationPermissionSnapshot> {
  const platform = Capacitor.getPlatform();
  if (!Capacitor.isNativePlatform()) {
    return { isNative: false, platform, display: "unavailable", exactAlarm: "not-applicable" };
  }
  const permission = await LocalNotifications.checkPermissions();
  let exactAlarm: NotificationPermissionSnapshot["exactAlarm"] = "not-applicable";
  if (platform === "android") {
    try {
      exactAlarm = normalizePermission((await LocalNotifications.checkExactNotificationSetting()).exact_alarm);
    } catch {
      exactAlarm = "unavailable";
    }
  }
  return { isNative: true, platform, display: normalizePermission(permission.display), exactAlarm };
}

/** Requests display permission and returns the complete refreshed permission snapshot. */
export async function requestNotificationPermission(): Promise<NotificationPermissionSnapshot> {
  if (!Capacitor.isNativePlatform()) return getNotificationPermissionSnapshot();
  await LocalNotifications.requestPermissions();
  return getNotificationPermissionSnapshot();
}

/** Opens Android's exact-alarm access screen and returns the reported state when control returns. */
export async function openExactAlarmSettings(): Promise<NotificationPermissionSnapshot> {
  if (Capacitor.getPlatform() === "android") await LocalNotifications.changeExactNotificationSetting();
  return getNotificationPermissionSnapshot();
}

/** Ensures display permission and the custom Android channel before creating an alert. */
async function prepareNotifications(): Promise<boolean> {
  const permission = await LocalNotifications.checkPermissions();
  const resolved = permission.display === "prompt" || permission.display === "prompt-with-rationale"
    ? await LocalNotifications.requestPermissions()
    : permission;
  if (resolved.display !== "granted") return false;
  if (Capacitor.getPlatform() === "android") await LocalNotifications.createChannel(createAndroidNotificationChannel());
  return true;
}

/** Reports whether Android currently grants precise alarm scheduling; other platforms do not need the flag. */
async function hasExactAlarmAccess(): Promise<boolean> {
  if (Capacitor.getPlatform() !== "android") return true;
  try {
    return (await LocalNotifications.checkExactNotificationSetting()).exact_alarm === "granted";
  } catch {
    return false;
  }
}

/** Creates an explicit one-shot schedule that falls back to inexact delivery when exact access is absent. */
function createNotificationSchedule(at: Date, exactAlarmGranted: boolean): NonNullable<LocalNotificationSchema["schedule"]> {
  return {
    at,
    allowWhileIdle: true,
    ...(Capacitor.getPlatform() === "android" ? { isExactNotification: exactAlarmGranted } : {}),
  };
}

/** Adds common channel, sound, and ownership metadata to every managed notification. */
function createNotificationBase(extra: Record<string, unknown>): Pick<LocalNotificationSchema, "channelId" | "sound" | "extra"> {
  return {
    channelId: notificationChannelId,
    ...getNotificationSoundOptions(Capacitor.getPlatform()),
    extra: { notificationOwner, ...extra },
  };
}

/** Builds upcoming informational routine notifications without creating ACTIVE state. */
function createRoutineNotifications(state: AppState, now: Date, exactAlarmGranted: boolean): LocalNotificationSchema[] {
  const rangeEnd = new Date(now.getTime() + notificationHorizonDays * 24 * 60 * 60_000);
  return getRoutineOccurrences(state.idealRoutines, now, rangeEnd)
    .filter((occurrence) => occurrence.startAt > now)
    .map((occurrence) => {
      const occurrenceKey = createRoutineOccurrenceKey(occurrence.routine.id, occurrence.startAt);
      return {
        id: createNotificationId(`routine-start:${occurrenceKey}`),
        title: "루틴 시작",
        body: `${occurrence.routine.title} 루틴의 시작 시간입니다. 앱에서 현재 지령을 확인하세요.`,
        ...createNotificationBase({
          notificationKind: "routineStart",
          route: "/schedule",
          routineId: occurrence.routine.id,
          routineStartAt: occurrence.startAt.toISOString(),
        }),
        // The short grace lets a visible app cancel this informational alert before issuing a real directive.
        schedule: createNotificationSchedule(
          new Date(occurrence.startAt.getTime() + foregroundRoutineCancellationGraceMs),
          exactAlarmGranted,
        ),
      };
    });
}

/** Builds the one expected-end confirmation for the current ACTIVE directive. */
function createActiveEndNotification(
  state: AppState,
  now: Date,
  exactAlarmGranted: boolean,
  receipt: NotificationSyncReceipt,
): LocalNotificationSchema | null {
  const ticket = getActiveTicket(state);
  if (!ticket || isUnlimitedDurationTicket(ticket)) return null;
  const expectedAt = getTicketExpectedEndAt(ticket);
  if (expectedAt <= now && receipt.endReminderTicketIds.includes(ticket.id)) return null;
  return {
    id: createNotificationId(`directive-end:${ticket.id}`),
    title: "지령 확인",
    body: "예상 수행시간이 종료되었습니다. 수행 결과를 기록하세요.",
    ...createNotificationBase({ notificationKind: "directiveEnd", route: "/", ticketId: ticket.id }),
    ...(expectedAt > now ? { schedule: createNotificationSchedule(expectedAt, exactAlarmGranted) } : {}),
  };
}

/** Recognizes current and legacy reservations owned by this feature without touching unrelated native alerts. */
function isManagedNotification(notification: { extra?: unknown }): boolean {
  if (!notification.extra || typeof notification.extra !== "object") return false;
  const extra = notification.extra as Record<string, unknown>;
  return extra.notificationOwner === notificationOwner || typeof extra.routineId === "string" || typeof extra.ticketId === "string";
}

/** Returns one owned notification kind without trusting plugin payloads. */
function getManagedNotificationKind(notification: { extra?: unknown }): string | undefined {
  if (!notification.extra || typeof notification.extra !== "object") return undefined;
  const kind = (notification.extra as Record<string, unknown>).notificationKind;
  return typeof kind === "string" ? kind : undefined;
}

/** Converts one pending plugin schedule into a comparable timestamp. */
function getPendingNotificationTime(notification: PendingLocalNotificationSchema): number | null {
  const at = notification.schedule?.at;
  if (!at) return null;
  const date = at instanceof Date ? at : new Date(at);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

/** Reconciles routine and ACTIVE-end reservations, then emits a new-ACTIVE alert only for an explicit transition. */
async function syncLocalNotifications(state: AppState, options: LocalNotificationSyncOptions): Promise<void> {
  if (!(await prepareNotifications())) return;
  const exactAlarmGranted = await hasExactAlarmAccess();
  const now = new Date();
  const receipt = readNotificationReceipt();
  const activeTicket = getActiveTicket(state);
  const desired = createRoutineNotifications(state, now, exactAlarmGranted);
  const endNotification = createActiveEndNotification(state, now, exactAlarmGranted, receipt);
  if (endNotification) desired.push(endNotification);
  const desiredById = new Map(desired.map((notification) => [notification.id, notification]));

  const pending = await LocalNotifications.getPending();
  const managedPending = pending.notifications.filter(isManagedNotification);
  const resynchronizablePending = managedPending.filter((notification) => getManagedNotificationKind(notification) !== "notificationTest");
  const obsolete = resynchronizablePending.filter((notification) => (
    options.forceNotificationResync || !desiredById.has(notification.id)
  ));
  if (obsolete.length > 0) await LocalNotifications.cancel({ notifications: obsolete.map(({ id }) => ({ id })) });

  const retainedIds = options.forceNotificationResync
    ? new Set<number>()
    : new Set(resynchronizablePending.filter((notification) => desiredById.has(notification.id)).map(({ id }) => id));
  const missing = desired.filter((notification) => !retainedIds.has(notification.id));
  if (missing.length > 0) await LocalNotifications.schedule({ notifications: missing });

  if (activeTicket && endNotification && !receipt.endReminderTicketIds.includes(activeTicket.id)) {
    receipt.endReminderTicketIds.push(activeTicket.id);
  }
  if (activeTicket && options.issuedTicketId === activeTicket.id && receipt.lastIssuedTicketId !== activeTicket.id) {
    if (!options.suppressIssuedNotification) {
      await LocalNotifications.schedule({ notifications: [{
        id: createNotificationId(`directive-issued:${activeTicket.id}`),
        title: "지령 발급",
        body: activeTicket.action,
        ...createNotificationBase({ notificationKind: "directiveIssued", route: "/", ticketId: activeTicket.id }),
      }] });
    }
    receipt.lastIssuedTicketId = activeTicket.id;
  }
  writeNotificationReceipt(receipt);
}

/** Inspects only this app's pending native reservations without changing permission state. */
export async function getNotificationDiagnostics(): Promise<NotificationDiagnostics> {
  const permission = await getNotificationPermissionSnapshot();
  if (!permission.isNative) return { permission, pendingCount: 0 };
  const pending = await LocalNotifications.getPending();
  const managed = pending.notifications.filter(isManagedNotification);
  const upcoming = managed
    .map((notification) => ({
      notification,
      time: getPendingNotificationTime(notification),
    }))
    .filter((item): item is { notification: PendingLocalNotificationSchema; time: number } => item.time !== null)
    .sort((left, right) => left.time - right.time)[0];
  return {
    permission,
    pendingCount: managed.length,
    ...(upcoming ? {
      nextNotificationAt: new Date(upcoming.time).toISOString(),
      nextNotificationKind: getManagedNotificationKind(upcoming.notification),
    } : {}),
  };
}

/** Schedules one custom-sound test alert after a short delay and returns its diagnostics. */
export async function scheduleNotificationTest(delayMilliseconds = 10_000): Promise<NotificationDiagnostics> {
  if (!Capacitor.isNativePlatform()) return getNotificationDiagnostics();
  if (!(await prepareNotifications())) throw new Error("Notification display permission is required.");
  const exactAlarmGranted = await hasExactAlarmAccess();
  const scheduledAt = new Date(Date.now() + Math.max(1_000, delayMilliseconds));
  await LocalNotifications.schedule({ notifications: [{
    id: createNotificationId(`notification-test:${Date.now()}`),
    title: "알림 시험",
    body: "지령 단말기의 알림이 정상적으로 도착했습니다.",
    ...createNotificationBase({ notificationKind: "notificationTest", route: "/settings" }),
    schedule: createNotificationSchedule(scheduledAt, exactAlarmGranted),
  }] });
  return getNotificationDiagnostics();
}

/** Cancels one pre-scheduled routine alert immediately before foreground Planner reevaluation. */
export async function cancelRoutineStartNotification(routineId: string, startAt: Date): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await LocalNotifications.cancel({ notifications: [
    { id: createNotificationId(`routine-start:${createRoutineOccurrenceKey(routineId, startAt)}`) },
  ] });
}

/** Emits one informational routine-start alert when an existing ACTIVE prevents foreground reissuance. */
export async function sendRoutineStartNotification(occurrence: RoutineOccurrence): Promise<void> {
  if (!Capacitor.isNativePlatform() || !(await prepareNotifications())) return;
  const occurrenceKey = createRoutineOccurrenceKey(occurrence.routine.id, occurrence.startAt);
  const receipt = readNotificationReceipt();
  if (receipt.routineAnnouncementKeys.includes(occurrenceKey)) return;
  await LocalNotifications.schedule({ notifications: [{
    id: createNotificationId(`routine-start:${occurrenceKey}`),
    title: "루틴 시작",
    body: `${occurrence.routine.title} 루틴의 시작 시간입니다. 앱에서 현재 지령을 확인하세요.`,
    ...createNotificationBase({
      notificationKind: "routineStart",
      route: "/schedule",
      routineId: occurrence.routine.id,
      routineStartAt: occurrence.startAt.toISOString(),
    }),
  }] });
  receipt.routineAnnouncementKeys.push(occurrenceKey);
  writeNotificationReceipt(receipt);
}

/** Subscribes to taps on informational routine notifications so foreground state can run the Planner. */
export async function addRoutineNotificationActionListener(
  listener: (action: RoutineNotificationAction) => void | Promise<void>,
): Promise<() => Promise<void>> {
  if (!Capacitor.isNativePlatform()) return async () => undefined;
  const handle = await LocalNotifications.addListener("localNotificationActionPerformed", (action) => {
    const extra = action.notification.extra as Record<string, unknown> | undefined;
    if (extra?.notificationKind !== "routineStart" || typeof extra.routineId !== "string" || typeof extra.routineStartAt !== "string") return;
    void listener({ routineId: extra.routineId, startAt: extra.routineStartAt });
  });
  return () => handle.remove();
}

/** Copies the current directive into native storage consumed by the Android home widget. */
async function syncDirectiveWidget(state: AppState): Promise<void> {
  const ticket = getActiveTicket(state);
  await DirectiveWidget.sync({
    recipient: ticket?.recipient ?? "사용자",
    trigger: ticket?.trigger ?? (state.plannerDeferral ? "지령 발행 보류" : "현재 활성 지령이 없습니다."),
    action: ticket?.action ?? state.plannerDeferral?.reason ?? "앱을 열어 다음 지령을 발행하세요.",
    deadline: ticket?.deadline ?? "",
  });
}

/** Synchronizes native reservations serially and refreshes Android-only widget snapshots. */
export function syncNativeExperience(state: AppState, options: NativeExperienceSyncOptions = {}): Promise<void> {
  if (!Capacitor.isNativePlatform()) return Promise.resolve();
  const notificationOptions: LocalNotificationSyncOptions = {
    ...options,
    suppressIssuedNotification: options.issuedTicketId !== undefined && isAppVisible(),
  };
  const synchronize = async () => {
    const results = await Promise.allSettled([
      syncLocalNotifications(state, notificationOptions),
      ...(Capacitor.getPlatform() === "android"
        ? [syncDirectiveWidget(state), calendarWidgetBridge.sync({ days: createCalendarWidgetDays(state.tasks) })]
        : []),
    ]);
    for (const result of results) {
      if (result.status === "rejected") console.warn("Native notification or widget synchronization failed.");
    }
  };
  nativeSyncQueue = nativeSyncQueue.then(synchronize, synchronize);
  return nativeSyncQueue;
}

/** Rebuilds all managed routine and ACTIVE reservations from the latest persisted state. */
export function resynchronizeNativeNotifications(state: AppState): Promise<void> {
  if (!Capacitor.isNativePlatform()) return Promise.resolve();
  const synchronize = () => syncLocalNotifications(state, { forceNotificationResync: true });
  nativeSyncQueue = nativeSyncQueue.then(synchronize, synchronize);
  return nativeSyncQueue;
}

/** Returns the saved routine for a notification action while rejecting stale or deleted sources. */
export function findRoutineForNotification(state: AppState, routineId: string): IdealRoutine | null {
  return state.idealRoutines.find((routine) => routine.id === routineId && routine.enabled) ?? null;
}
