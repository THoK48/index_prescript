import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { CalendarWidgetDay } from "./calendarWidget";

/** Android bridge for read-only widget snapshots and acknowledged launch requests. */
interface CalendarWidgetPlugin {
  sync(options: { days: CalendarWidgetDay[] }): Promise<void>;
  getLaunchRequest(): Promise<{ request: unknown }>;
  acknowledgeLaunch(options: { requestId: string }): Promise<{ acknowledged: boolean }>;
  addListener(eventName: "calendarLaunch", listener: (request: unknown) => void): Promise<PluginListenerHandle>;
}

/** Registered only by Android; callers gate all invocations by native platform availability. */
export const calendarWidgetBridge = registerPlugin<CalendarWidgetPlugin>("CalendarWidget");
