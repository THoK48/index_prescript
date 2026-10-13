import type { IdealRoutine, LocalScheduleItem, RecurrenceRule } from "./ticketMachine.ts";

export type CalendarValidationResult<T> =
  | { kind: "success"; value: T }
  | { kind: "invalid"; message: string };

/** Converts a local HH:mm value to minutes since the start of the day. */
export function timeToMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Normalizes recurrence data so weekly rules always carry valid unique weekdays. */
export function normalizeRecurrence(recurrence?: RecurrenceRule): RecurrenceRule {
  if (!recurrence || recurrence.frequency === "NONE") return { frequency: "NONE" };
  if (recurrence.frequency === "DAILY") return { frequency: "DAILY" };
  const daysOfWeek = [...new Set(recurrence.daysOfWeek ?? [])]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((left, right) => left - right);
  return { frequency: "WEEKLY", daysOfWeek };
}

/** Validates and creates one local schedule item. */
export function createLocalScheduleItem(
  draft: Omit<LocalScheduleItem, "id">,
  id: string,
): CalendarValidationResult<LocalScheduleItem> {
  const startAt = new Date(draft.startAt);
  const endAt = new Date(draft.endAt);
  if (!draft.title.trim()) return { kind: "invalid", message: "일정명을 입력해 주세요." };
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || endAt <= startAt) {
    return { kind: "invalid", message: "종료 시간은 시작 시간보다 늦어야 합니다." };
  }
  const recurrence = normalizeRecurrence(draft.recurrence);
  if (recurrence.frequency === "WEEKLY" && recurrence.daysOfWeek?.length === 0) {
    return { kind: "invalid", message: "매주 반복할 요일을 하나 이상 선택해 주세요." };
  }
  return {
    kind: "success",
    value: { ...draft, id, title: draft.title.trim(), recurrence },
  };
}

/** Validates and creates one ideal routine without interpreting it as a fixed event. */
export function createIdealRoutine(
  draft: Omit<IdealRoutine, "id">,
  id: string,
): CalendarValidationResult<IdealRoutine> {
  if (!draft.title.trim()) return { kind: "invalid", message: "루틴명을 입력해 주세요." };
  const startMinutes = timeToMinutes(draft.startTime);
  const endMinutes = draft.endTime ? timeToMinutes(draft.endTime) : null;
  if (startMinutes === null || (draft.endTime && endMinutes === null)) {
    return { kind: "invalid", message: "루틴 시간을 확인해 주세요." };
  }
  const daysOfWeek = [...new Set(draft.daysOfWeek)]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((left, right) => left - right);
  if (daysOfWeek.length === 0) return { kind: "invalid", message: "루틴 요일을 하나 이상 선택해 주세요." };
  if (draft.priority < 1 || draft.priority > 5) return { kind: "invalid", message: "우선순위는 1에서 5 사이여야 합니다." };
  return {
    kind: "success",
    value: { ...draft, id, title: draft.title.trim(), daysOfWeek },
  };
}

/** Returns whether a recurring schedule occurs on the supplied local calendar date. */
export function scheduleOccursOnDate(item: LocalScheduleItem, date: Date): boolean {
  const original = new Date(item.startAt);
  const recurrence = normalizeRecurrence(item.recurrence);
  const originalDay = new Date(original.getFullYear(), original.getMonth(), original.getDate()).getTime();
  const targetDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (targetDay < originalDay) return false;
  if (recurrence.frequency === "NONE") return targetDay === originalDay;
  if (recurrence.frequency === "DAILY") return true;
  return recurrence.daysOfWeek?.includes(date.getDay()) ?? false;
}

/** Places a recurring schedule occurrence on a target local date while preserving its duration. */
export function getScheduleOccurrence(item: LocalScheduleItem, date: Date): { startAt: Date; endAt: Date } | null {
  if (!scheduleOccursOnDate(item, date)) return null;
  const sourceStart = new Date(item.startAt);
  const duration = new Date(item.endAt).getTime() - sourceStart.getTime();
  const startAt = new Date(date.getFullYear(), date.getMonth(), date.getDate(), sourceStart.getHours(), sourceStart.getMinutes());
  return { startAt, endAt: new Date(startAt.getTime() + duration) };
}

/** Returns the local start/end window for an enabled routine on a target date. */
export function getRoutineWindow(routine: IdealRoutine, date: Date): { startAt: Date; endAt: Date } | null {
  if (!routine.enabled || !routine.daysOfWeek.includes(date.getDay())) return null;
  const startMinutes = timeToMinutes(routine.startTime);
  const endMinutes = routine.endTime ? timeToMinutes(routine.endTime) : null;
  if (startMinutes === null) return null;
  const startAt = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(startMinutes / 60), startMinutes % 60);
  const effectiveEnd = endMinutes ?? startMinutes + 30;
  const endAt = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(effectiveEnd / 60), effectiveEnd % 60);
  if (endAt <= startAt) endAt.setDate(endAt.getDate() + 1);
  return { startAt, endAt };
}

/** Expands schedule occurrences across an inclusive local-date range. */
export function getScheduleOccurrences(
  items: LocalScheduleItem[],
  rangeStart: Date,
  rangeEnd: Date,
): Array<{ item: LocalScheduleItem; startAt: Date; endAt: Date }> {
  const occurrences: Array<{ item: LocalScheduleItem; startAt: Date; endAt: Date }> = [];
  const cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate());
  const lastDay = new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), rangeEnd.getDate()).getTime();
  while (cursor.getTime() <= lastDay) {
    for (const item of items) {
      const occurrence = getScheduleOccurrence(item, cursor);
      if (occurrence && occurrence.endAt >= rangeStart && occurrence.startAt <= rangeEnd) {
        occurrences.push({ item, ...occurrence });
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return occurrences.sort((left, right) => left.startAt.getTime() - right.startAt.getTime());
}
