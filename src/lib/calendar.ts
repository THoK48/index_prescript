import type { IdealRoutine, LocalScheduleItem, RecurrenceRule, RoutineTimingMode } from "./ticketMachine.ts";

export type CalendarValidationResult<T> =
  | { kind: "success"; value: T }
  | { kind: "invalid"; message: string };

/** Formats a local date without converting it through UTC. */
export function formatLocalDateKey(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Converts a local HH:mm value to minutes since the start of the day. */
export function timeToMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Normalizes keyboard-entered 24-hour time from H:mm, HH:mm, or compact HHmm notation. */
export function normalizeTimeInput(value: string): string | null {
  const trimmed = value.trim();
  const separated = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  const compact = /^(\d{2})(\d{2})$/.exec(trimmed);
  const hours = Number(separated?.[1] ?? compact?.[1]);
  const minutes = Number(separated?.[2] ?? compact?.[2]);
  if ((!separated && !compact) || !Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59) {
    return null;
  }
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
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
  if (draft.endTime && endMinutes === startMinutes) {
    return { kind: "invalid", message: "시작과 종료 시간은 같을 수 없습니다." };
  }
  const daysOfWeek = [...new Set(draft.daysOfWeek)]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((left, right) => left - right);
  if (daysOfWeek.length === 0) return { kind: "invalid", message: "루틴 요일을 하나 이상 선택해 주세요." };
  if (draft.priority < 1 || draft.priority > 5) return { kind: "invalid", message: "우선순위는 1에서 5 사이여야 합니다." };
  if (draft.timingMode !== "FIXED" && draft.timingMode !== "FLEXIBLE") {
    return { kind: "invalid", message: "루틴 시간 유형을 선택해 주세요." };
  }
  if ((draft.steps?.length ?? 0) > 20) {
    return { kind: "invalid", message: "상세 단계는 최대 20개까지 등록할 수 있습니다." };
  }
  const stepIds = new Set<string>();
  const steps = [] as NonNullable<IdealRoutine["steps"]>;
  for (const step of draft.steps ?? []) {
    const title = step.title.trim();
    if (!title) return { kind: "invalid", message: "상세 단계의 행동을 입력해 주세요." };
    if (stepIds.has(step.id)) return { kind: "invalid", message: "상세 단계 ID가 중복되었습니다." };
    if (step.actionType !== "DURATION" && step.actionType !== "COMPLETION" && step.actionType !== "MOVEMENT") {
      return { kind: "invalid", message: "상세 단계의 행동 유형을 확인해 주세요." };
    }
    if (!Number.isInteger(step.expectedMinutes) || step.expectedMinutes < 1 || step.expectedMinutes > 120) {
      return { kind: "invalid", message: "상세 단계의 예상 시간은 1~120분이어야 합니다." };
    }
    stepIds.add(step.id);
    steps.push({ ...step, title });
  }
  const dateOverrides = [] as NonNullable<IdealRoutine["dateOverrides"]>;
  const overrideDates = new Set<string>();
  for (const override of draft.dateOverrides ?? []) {
    const overrideStart = timeToMinutes(override.startTime);
    const overrideEnd = override.endTime ? timeToMinutes(override.endTime) : null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(override.dateKey) || overrideDates.has(override.dateKey) ||
        overrideStart === null || (override.endTime && overrideEnd === null) || overrideEnd === overrideStart ||
        (override.startDayOffset !== undefined && override.startDayOffset !== 0 && override.startDayOffset !== 1)) {
      return { kind: "invalid", message: "오늘만 변경한 루틴 시간을 확인해 주세요." };
    }
    overrideDates.add(override.dateKey);
    dateOverrides.push({ ...override, startDayOffset: override.startDayOffset ?? 0 });
  }
  return {
    kind: "success",
    value: { ...draft, id, title: draft.title.trim(), daysOfWeek, steps, locked: Boolean(draft.locked), dateOverrides },
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
  const override = routine.dateOverrides?.find((item) => item.dateKey === formatLocalDateKey(date));
  const startTime = override?.startTime ?? routine.startTime;
  const endTime = override ? override.endTime : routine.endTime;
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = endTime ? timeToMinutes(endTime) : null;
  if (startMinutes === null || (endTime && endMinutes === startMinutes)) return null;
  const startAt = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(startMinutes / 60), startMinutes % 60);
  startAt.setDate(startAt.getDate() + (override?.startDayOffset ?? 0));
  const effectiveEnd = endMinutes ?? startMinutes + 30;
  const endAt = new Date(startAt.getFullYear(), startAt.getMonth(), startAt.getDate(), Math.floor(effectiveEnd / 60), effectiveEnd % 60);
  if (endAt <= startAt) endAt.setDate(endAt.getDate() + 1);
  return { startAt, endAt };
}

export interface RoutineOccurrence {
  routine: IdealRoutine;
  startAt: Date;
  endAt: Date;
}

export interface RoutineOverlapConflict {
  routine: IdealRoutine;
  sharedDays: number[];
}

interface WeeklyRoutineInterval {
  start: number;
  end: number;
}

const minutesPerWeek = 7 * 24 * 60;

/** Expands one weekly routine into linear minute intervals, retaining overnight spill into the next week. */
function createWeeklyRoutineIntervals(routine: Omit<IdealRoutine, "id"> | IdealRoutine): WeeklyRoutineInterval[] {
  const startMinutes = timeToMinutes(routine.startTime);
  const endMinutes = routine.endTime ? timeToMinutes(routine.endTime) : null;
  if (startMinutes === null || (routine.endTime && endMinutes === startMinutes)) return [];
  const duration = endMinutes === null
    ? 30
    : endMinutes > startMinutes
      ? endMinutes - startMinutes
      : endMinutes + 24 * 60 - startMinutes;
  return routine.daysOfWeek.map((day) => {
    const start = day * 24 * 60 + startMinutes;
    return { start, end: start + duration };
  });
}

/** Finds weekly time-window overlaps, including overnight routines across the Sunday boundary. */
export function getRoutineOverlapConflicts(
  routines: IdealRoutine[],
  candidate: Omit<IdealRoutine, "id"> | IdealRoutine,
  excludedRoutineId?: string,
): RoutineOverlapConflict[] {
  const candidateIntervals = createWeeklyRoutineIntervals(candidate);
  return routines.flatMap((routine) => {
    if (routine.id === excludedRoutineId) return [];
    const sharedDays = new Set<number>();
    for (const candidateInterval of candidateIntervals) {
      for (const savedInterval of createWeeklyRoutineIntervals(routine)) {
        for (const weekShift of [-minutesPerWeek, 0, minutesPerWeek]) {
          const shiftedStart = savedInterval.start + weekShift;
          const shiftedEnd = savedInterval.end + weekShift;
          const overlapStart = Math.max(candidateInterval.start, shiftedStart);
          if (overlapStart < Math.min(candidateInterval.end, shiftedEnd)) {
            const normalizedMinute = ((overlapStart % minutesPerWeek) + minutesPerWeek) % minutesPerWeek;
            sharedDays.add(Math.floor(normalizedMinute / (24 * 60)));
          }
        }
      }
    }
    return sharedDays.size > 0 ? [{ routine, sharedDays: [...sharedDays].sort((left, right) => left - right) }] : [];
  });
}

/** Expands enabled routine windows across an inclusive local-date range in stable chronological order. */
export function getRoutineOccurrences(
  routines: IdealRoutine[],
  rangeStart: Date,
  rangeEnd: Date,
): RoutineOccurrence[] {
  const occurrences: RoutineOccurrence[] = [];
  const cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate());
  const lastDay = new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), rangeEnd.getDate()).getTime();
  while (cursor.getTime() <= lastDay) {
    for (const routine of routines) {
      const window = getRoutineWindow(routine, cursor);
      if (window && window.endAt >= rangeStart && window.startAt <= rangeEnd) {
        occurrences.push({ routine, ...window });
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return occurrences.sort((left, right) => left.startAt.getTime() - right.startAt.getTime()
    || (left.routine.id < right.routine.id ? -1 : left.routine.id > right.routine.id ? 1 : 0));
}

/** Returns the next enabled routine start after now for the requested timing behavior. */
export function getNextRoutineOccurrence(
  routines: IdealRoutine[],
  now: Date,
  timingMode: RoutineTimingMode | "ANY" = "FIXED",
): RoutineOccurrence | null {
  const rangeEnd = new Date(now.getTime() + 8 * 24 * 60 * 60_000);
  const eligibleRoutines = timingMode === "ANY"
    ? routines
    : routines.filter((routine) => routine.timingMode === timingMode);
  return getRoutineOccurrences(eligibleRoutines, now, rangeEnd)
    .find((occurrence) => occurrence.startAt > now) ?? null;
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
