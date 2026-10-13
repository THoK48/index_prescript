import { Capacitor, registerPlugin } from "@capacitor/core";
import { LocalNotifications, type LocalNotificationSchema } from "@capacitor/local-notifications";
import { getRoutineWindow } from "./calendar";
import { getActiveTicket, type AppState } from "./ticketMachine";
import { createCalendarWidgetDays } from "./calendarWidget";
import { calendarWidgetBridge } from "./calendarWidgetBridge";
import {
  createAndroidNotificationChannel,
  getNotificationSoundOptions,
  notificationChannelId,
} from "./notificationSound";

interface DirectiveWidgetPlugin {
  sync(options: {
    recipient: string;
    trigger: string;
    action: string;
    deadline: string;
  }): Promise<void>;
}

const DirectiveWidget = registerPlugin<DirectiveWidgetPlugin>("DirectiveWidget");

/** Creates a stable positive Android notification identifier from arbitrary text. */
function createNotificationId(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return 1_000 + (Math.abs(hash) % 2_000_000_000);
}

/** Builds the next seven days of enabled routine-start notifications. */
function createRoutineNotifications(state: AppState, now: Date): LocalNotificationSchema[] {
  const notifications: LocalNotificationSchema[] = [];
  for (let dayOffset = 0; dayOffset <= 7; dayOffset += 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
    for (const routine of state.idealRoutines) {
      const window = getRoutineWindow(routine, date);
      if (!window || window.startAt <= now) continue;
      notifications.push({
        id: createNotificationId(`routine:${routine.id}:${window.startAt.toISOString()}`),
        title: "루틴 시작",
        body: `${routine.title} 수행 시간입니다.`,
        channelId: notificationChannelId,
        ...getNotificationSoundOptions(Capacitor.getPlatform()),
        schedule: { at: window.startAt, allowWhileIdle: true },
        extra: { route: "/schedule", routineId: routine.id },
      });
    }
  }
  return notifications;
}

/** Builds an alert for the expected end of the currently active directive. */
function createActiveDirectiveNotification(state: AppState, now: Date): LocalNotificationSchema | null {
  const ticket = getActiveTicket(state);
  if (!ticket) return null;
  const expectedAt = new Date(new Date(ticket.createdAt).getTime() + ticket.expectedMinutes * 60_000);
  if (expectedAt <= now) return null;
  return {
    id: createNotificationId(`ticket:${ticket.id}`),
    title: "지령 확인",
    body: ticket.action,
    channelId: notificationChannelId,
    ...getNotificationSoundOptions(Capacitor.getPlatform()),
    schedule: { at: expectedAt, allowWhileIdle: true },
    extra: { route: "/", ticketId: ticket.id },
  };
}

/** Replaces this app's pending local alerts with notifications derived from current state. */
async function syncLocalNotifications(state: AppState): Promise<void> {
  const permission = await LocalNotifications.checkPermissions();
  const resolvedPermission = permission.display === "prompt"
    ? await LocalNotifications.requestPermissions()
    : permission;
  if (resolvedPermission.display !== "granted") return;

  if (Capacitor.getPlatform() === "android") {
    await LocalNotifications.createChannel(createAndroidNotificationChannel());
  }

  const pending = await LocalNotifications.getPending();
  if (pending.notifications.length > 0) {
    await LocalNotifications.cancel({ notifications: pending.notifications.map(({ id }) => ({ id })) });
  }

  const now = new Date();
  const notifications = createRoutineNotifications(state, now);
  const directiveNotification = createActiveDirectiveNotification(state, now);
  if (directiveNotification) notifications.push(directiveNotification);
  if (notifications.length > 0) await LocalNotifications.schedule({ notifications });
}

/** Copies the current directive into native storage consumed by the Android home widget. */
async function syncDirectiveWidget(state: AppState): Promise<void> {
  const ticket = getActiveTicket(state);
  await DirectiveWidget.sync({
    recipient: ticket?.recipient ?? "사용자",
    trigger: ticket?.trigger ?? "현재 활성 지령이 없습니다.",
    action: ticket?.action ?? "앱을 열어 다음 지령을 발행하세요.",
    deadline: ticket?.deadline ?? "",
  });
}

/** Synchronizes native notifications on both mobile platforms and Android-only widget snapshots. */
export async function syncNativeExperience(state: AppState): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const results = await Promise.allSettled([
    syncLocalNotifications(state),
    ...(Capacitor.getPlatform() === "android"
      ? [syncDirectiveWidget(state), calendarWidgetBridge.sync({ days: createCalendarWidgetDays(state.tasks) })]
      : []),
  ]);
  for (const result of results) {
    if (result.status === "rejected") console.warn("Native notification or widget synchronization failed.");
  }
}
