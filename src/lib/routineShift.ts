import {
  formatLocalDateKey,
  getRoutineOverlapConflicts,
  getRoutineWindow,
  timeToMinutes,
} from "./calendar.ts";
import type { IdealRoutine, RoutineDateOverride } from "./ticketMachine.ts";

export type RoutineEditScope = "RECURRING" | "TODAY";

export interface RoutineShiftChange {
  routineId: string;
  title: string;
  beforeStartTime: string;
  beforeEndTime?: string;
  afterStartTime: string;
  afterEndTime?: string;
  beforeDays: number[];
  afterDays: number[];
  startDayOffset: 0 | 1;
  isEditedRoutine: boolean;
}

export interface RoutineShiftPreview {
  scope: RoutineEditScope;
  dateKey?: string;
  hasConflict: boolean;
  conflictingRoutineTitles: string[];
  deltaMinutes: number;
  changes: RoutineShiftChange[];
  lockedRoutineTitles: string[];
  blockedReasons: string[];
  crossesMidnight: boolean;
  updatedRoutines: IdealRoutine[];
}

interface MinuteRange {
  start: number;
  end: number;
  duration: number;
}

const minutesPerDay = 24 * 60;

/** Converts one routine time pair into a linear range that can cross midnight. */
function createMinuteRange(startTime: string, endTime?: string, startDayOffset = 0): MinuteRange | null {
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = endTime ? timeToMinutes(endTime) : null;
  if (startMinutes === null || (endTime && endMinutes === startMinutes)) return null;
  const start = startDayOffset * minutesPerDay + startMinutes;
  const duration = endMinutes === null
    ? 30
    : endMinutes > startMinutes
      ? endMinutes - startMinutes
      : endMinutes + minutesPerDay - startMinutes;
  return { start, end: start + duration, duration };
}

/** Formats linear minutes back into a normalized HH:mm value. */
function formatMinutes(value: number): string {
  const normalized = ((value % minutesPerDay) + minutesPerDay) % minutesPerDay;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

/** Rotates recurring weekdays when a shifted start moves into the following day. */
function shiftWeekdays(days: number[], offset: number): number[] {
  return [...new Set(days.map((day) => ((day + offset) % 7 + 7) % 7))].sort((left, right) => left - right);
}

/** Replaces one date override while keeping only the most recent month of exceptions. */
function withDateOverride(routine: IdealRoutine, override: RoutineDateOverride): IdealRoutine {
  const dateOverrides = [...(routine.dateOverrides ?? []).filter((item) => item.dateKey !== override.dateKey), override]
    .slice(-31);
  return { ...routine, dateOverrides };
}

/** Converts one concrete occurrence into minutes relative to the supplied local date. */
function getOccurrenceRange(routine: IdealRoutine, date: Date, baseDate: Date = date): MinuteRange | null {
  const window = getRoutineWindow(routine, date);
  if (!window) return null;
  const dayStart = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate()).getTime();
  const start = Math.round((window.startAt.getTime() - dayStart) / 60_000);
  const end = Math.round((window.endAt.getTime() - dayStart) / 60_000);
  return { start, end, duration: end - start };
}

/** Reports interval overlap without treating touching boundaries as a collision. */
function overlaps(left: MinuteRange, right: MinuteRange): boolean {
  return Math.max(left.start, right.start) < Math.min(left.end, right.end);
}

/** Creates a stable, reviewable schedule plan without mutating Planner or ACTIVE state. */
export function createRoutineShiftPreview(
  routines: IdealRoutine[],
  original: IdealRoutine,
  edited: IdealRoutine,
  scope: RoutineEditScope,
  today: Date,
): RoutineShiftPreview {
  const dateKey = formatLocalDateKey(today);
  const blockedReasons: string[] = [];
  const lockedRoutineTitles = new Set<string>();
  const changedIds = new Set<string>([original.id]);
  const originalRange = scope === "TODAY"
    ? getOccurrenceRange(original, today)
    : createMinuteRange(original.startTime, original.endTime);
  const editedRange = createMinuteRange(edited.startTime, edited.endTime);
  if (!originalRange || !editedRange) {
    return {
      scope,
      ...(scope === "TODAY" ? { dateKey } : {}),
      hasConflict: false,
      conflictingRoutineTitles: [],
      deltaMinutes: 0,
      changes: [],
      lockedRoutineTitles: [],
      blockedReasons: ["수정 전후 루틴 시간을 계산할 수 없습니다."],
      crossesMidnight: false,
      updatedRoutines: routines,
    };
  }
  if (scope === "TODAY" && !getRoutineWindow(original, today)) {
    blockedReasons.push("이 루틴은 오늘 발생하지 않아 오늘만 변경할 수 없습니다.");
  }

  const deltaMinutes = editedRange.end - originalRange.end;
  const todayRanges = new Map<string, MinuteRange>();
  if (scope === "TODAY") {
    for (const routine of routines) {
      const range = getOccurrenceRange(routine, today);
      if (range) todayRanges.set(routine.id, range);
    }
  }
  const directConflictIds = new Set(scope === "RECURRING"
    ? getRoutineOverlapConflicts(routines, edited, original.id).map(({ routine }) => routine.id)
    : routines.flatMap((routine) => {
      if (routine.id === original.id) return [];
      const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
      const ranges = [
        getOccurrenceRange(routine, today, today),
        getOccurrenceRange(routine, tomorrow, today),
      ].filter((range): range is MinuteRange => range !== null);
      return ranges.some((range) => overlaps(editedRange, range)) ? [routine.id] : [];
    }));

  let updatedRoutines = routines.map((routine) => {
    if (routine.id !== original.id) return routine;
    if (scope === "RECURRING") return edited;
    return withDateOverride(routine, {
      dateKey,
      startTime: edited.startTime,
      endTime: edited.endTime,
      startDayOffset: 0,
    });
  });

  if (directConflictIds.size > 0 && deltaMinutes > 0) {
    updatedRoutines = updatedRoutines.map((routine) => {
      if (routine.id === original.id) return routine;
      const range = scope === "TODAY"
        ? todayRanges.get(routine.id) ?? null
        : createMinuteRange(routine.startTime, routine.endTime);
      const sharesRecurringDay = scope === "TODAY" || routine.daysOfWeek.some((day) => original.daysOfWeek.includes(day));
      if (!range || !sharesRecurringDay || range.start < originalRange.end) return routine;
      if (routine.locked) {
        lockedRoutineTitles.add(routine.title);
        return routine;
      }
      const shiftedStart = range.start + deltaMinutes;
      const shiftedEnd = range.end + deltaMinutes;
      const startDayOffset = Math.floor(shiftedStart / minutesPerDay);
      if (startDayOffset > 1 || shiftedStart < 0) {
        blockedReasons.push(`${routine.title}: 하루를 초과해 이동할 수 없습니다.`);
        return routine;
      }
      changedIds.add(routine.id);
      const startTime = formatMinutes(shiftedStart);
      const endTime = routine.endTime ? formatMinutes(shiftedEnd) : undefined;
      if (scope === "TODAY") {
        return withDateOverride(routine, {
          dateKey,
          startTime,
          endTime,
          startDayOffset: startDayOffset as 0 | 1,
        });
      }
      return {
        ...routine,
        startTime,
        endTime,
        daysOfWeek: startDayOffset === 1 ? shiftWeekdays(routine.daysOfWeek, 1) : routine.daysOfWeek,
      };
    });
  }

  const finalConflictLabels = new Set<string>();
  if (scope === "RECURRING") {
    for (const routine of updatedRoutines) {
      if (!changedIds.has(routine.id)) continue;
      for (const conflict of getRoutineOverlapConflicts(updatedRoutines, routine, routine.id)) {
        finalConflictLabels.add(`${routine.title} ↔ ${conflict.routine.title}`);
      }
    }
  } else {
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const finalRanges = updatedRoutines.flatMap((routine) => [
      { routine, occurrence: dateKey, range: getOccurrenceRange(routine, today, today) },
      { routine, occurrence: formatLocalDateKey(tomorrow), range: getOccurrenceRange(routine, tomorrow, today) },
    ]).filter((item): item is { routine: IdealRoutine; occurrence: string; range: MinuteRange } => item.range !== null);
    for (let leftIndex = 0; leftIndex < finalRanges.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < finalRanges.length; rightIndex += 1) {
        const left = finalRanges[leftIndex];
        const right = finalRanges[rightIndex];
        if (left.routine.id === right.routine.id && left.occurrence === right.occurrence) continue;
        if ((changedIds.has(left.routine.id) || changedIds.has(right.routine.id)) && overlaps(left.range, right.range)) {
          finalConflictLabels.add(`${left.routine.title} ↔ ${right.routine.title}`);
        }
      }
    }
  }
  if (finalConflictLabels.size > 0) {
    blockedReasons.push(`자동 이동 후에도 겹침: ${[...finalConflictLabels].join(", ")}`);
  }

  const changes = updatedRoutines.flatMap((routine): RoutineShiftChange[] => {
    if (!changedIds.has(routine.id)) return [];
    const before = routines.find((item) => item.id === routine.id);
    if (!before) return [];
    if (scope === "RECURRING") {
      const afterRange = createMinuteRange(routine.startTime, routine.endTime);
      const movedToNextWeekday = before.daysOfWeek.join(",") !== routine.daysOfWeek.join(",");
      return afterRange ? [{
        routineId: routine.id,
        title: routine.title,
        beforeStartTime: before.startTime,
        beforeEndTime: before.endTime,
        afterStartTime: routine.startTime,
        afterEndTime: routine.endTime,
        beforeDays: before.daysOfWeek,
        afterDays: routine.daysOfWeek,
        startDayOffset: movedToNextWeekday ? 1 : 0,
        isEditedRoutine: routine.id === original.id,
      }] : [];
    }
    const beforeRange = getOccurrenceRange(before, today);
    const afterRange = getOccurrenceRange(routine, today);
    const override = routine.dateOverrides?.find((item) => item.dateKey === dateKey);
    return beforeRange && afterRange && override ? [{
      routineId: routine.id,
      title: routine.title,
      beforeStartTime: formatMinutes(beforeRange.start),
      beforeEndTime: before.endTime ? formatMinutes(beforeRange.end) : undefined,
      afterStartTime: override.startTime,
      afterEndTime: override.endTime,
      beforeDays: before.daysOfWeek,
      afterDays: routine.daysOfWeek,
      startDayOffset: override.startDayOffset ?? 0,
      isEditedRoutine: routine.id === original.id,
    }] : [];
  });
  const crossesMidnight = changes.some((change) => change.startDayOffset === 1 || (
    change.afterEndTime !== undefined && (timeToMinutes(change.afterEndTime) ?? 0) <= (timeToMinutes(change.afterStartTime) ?? 0)
  ));

  return {
    scope,
    ...(scope === "TODAY" ? { dateKey } : {}),
    hasConflict: directConflictIds.size > 0,
    conflictingRoutineTitles: routines.filter((routine) => directConflictIds.has(routine.id)).map((routine) => routine.title),
    deltaMinutes,
    changes,
    lockedRoutineTitles: [...lockedRoutineTitles],
    blockedReasons,
    crossesMidnight,
    updatedRoutines,
  };
}

