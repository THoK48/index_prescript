import type { Task } from "./ticketMachine";

/** Minimal, read-only calendar data mirrored into Android widget storage. */
export interface CalendarWidgetDay {
  dateKey: string;
  count: number;
}

/** One explicit widget tap; a fresh ID distinguishes repeated taps on the same date. */
export interface CalendarWidgetLaunch {
  dateKey: string;
  requestId: string;
}

/** Formats dates in the device's local timezone, never by slicing a UTC timestamp. */
export function getCalendarWidgetDateKey(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Rejects malformed and rolled-over dates before a widget can open an editor. */
export function parseCalendarWidgetDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) && getCalendarWidgetDateKey(date) === value ? date : null;
}

/** Counts dated, unfinished tasks without copying titles or mutating original tasks. */
export function createCalendarWidgetDays(tasks: readonly Task[]): CalendarWidgetDay[] {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (!task.dueAt || task.status === "DONE") continue;
    const date = new Date(task.dueAt);
    if (!Number.isFinite(date.getTime())) continue;
    const dateKey = getCalendarWidgetDateKey(date);
    counts.set(dateKey, (counts.get(dateKey) ?? 0) + 1);
  }
  return [...counts].sort(([left], [right]) => left.localeCompare(right))
    .map(([dateKey, count]) => ({ dateKey, count }));
}

/** Validates the native boundary and allows only a date plus a bounded request identifier. */
export function parseCalendarWidgetLaunch(value: unknown): CalendarWidgetLaunch | null {
  if (!value || typeof value !== "object" || !("dateKey" in value) || !("requestId" in value)) return null;
  if (typeof value.dateKey !== "string" || !parseCalendarWidgetDate(value.dateKey)) return null;
  if (typeof value.requestId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(value.requestId)) return null;
  return { dateKey: value.dateKey, requestId: value.requestId };
}

/** Builds a fixed internal route; native input cannot supply an arbitrary destination. */
export function createCalendarWidgetUrl(launch: CalendarWidgetLaunch): string {
  const query = new URLSearchParams({ widgetDate: launch.dateKey, widgetRequestId: launch.requestId, newTask: "1" });
  return `/tasks/?${query.toString()}`;
}

/** Reads a one-time editor request from a statically exported calendar page. */
export function parseCalendarWidgetQuery(search: string): CalendarWidgetLaunch | null {
  const query = new URLSearchParams(search);
  if (query.get("newTask") !== "1") return null;
  return parseCalendarWidgetLaunch({ dateKey: query.get("widgetDate"), requestId: query.get("widgetRequestId") });
}
