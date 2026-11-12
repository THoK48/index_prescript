"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { DeletionUndoToast } from "@/components/DeletionUndoToast";
import { PageHeading } from "@/components/PageHeading";
import { ExecutionConstraintsEditor } from "@/components/ExecutionConstraintsEditor";
import type { ExecutionConstraints } from "@/lib/userContext";
import { formatLocalDateKey, getRoutineOverlapConflicts, getRoutineWindow, normalizeTimeInput, timeToMinutes } from "@/lib/calendar";
import { useLocalState } from "@/lib/localState";
import { createRoutineShiftPreview, type RoutineEditScope, type RoutineShiftPreview } from "@/lib/routineShift";
import type { IdealRoutine, RoutineActionType, RoutineStep, RoutineTimingMode } from "@/lib/ticketMachine";

const weekdays = [
  { value: 1, label: "월" }, { value: 2, label: "화" }, { value: 3, label: "수" },
  { value: 4, label: "목" }, { value: 5, label: "금" }, { value: 6, label: "토" },
  { value: 0, label: "일" },
];

const routineCategories: { value: IdealRoutine["category"]; label: string }[] = [
  { value: "sleep", label: "수면" }, { value: "meal", label: "식사" },
  { value: "work", label: "업무" }, { value: "study", label: "학업" },
  { value: "exercise", label: "운동" }, { value: "personal", label: "개인" },
  { value: "other", label: "기타" },
];

const routineActionTypes: { value: RoutineActionType; label: string; description: string }[] = [
  { value: "DURATION", label: "지속형", description: "예: 30분 동안 공부할 것." },
  { value: "COMPLETION", label: "완료형", description: "예: 마감 시각까지 퇴근할 것." },
  { value: "MOVEMENT", label: "이동형", description: "예: 지금 귀가를 시작할 것." },
];

/** Creates an editable detailed-routine step with a stable local identity. */
function createRoutineStepDraft(): RoutineStep {
  return {
    id: crypto.randomUUID(),
    title: "",
    actionType: "DURATION",
    expectedMinutes: 5,
  };
}

/** Toggles one weekday while keeping the values unique. */
function toggleWeekday(days: number[], day: number): number[] {
  return days.includes(day) ? days.filter((value) => value !== day) : [...days, day];
}

/** Returns the Korean label for one routine category. */
function formatRoutineCategory(category: IdealRoutine["category"]): string {
  return routineCategories.find((item) => item.value === category)?.label ?? "기타";
}

/** Formats recurring weekdays in the same Monday-through-Sunday order used by the editor. */
function formatRoutineWeekdays(days: number[]): string {
  return weekdays.filter((weekday) => days.includes(weekday.value)).map((weekday) => weekday.label).join("·");
}

interface RoutineTimeNotice {
  text: string;
  kind: "normal" | "overnight" | "invalid";
}

/** Makes same-day and next-day routine windows explicit, including their total duration. */
function describeRoutineTime(startTime: string, endTime?: string): RoutineTimeNotice {
  if (!endTime) return { text: "종료 시각 없음 · 기본 30분", kind: "normal" };
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = timeToMinutes(endTime);
  if (startMinutes === null || endMinutes === null) return { text: "시간 형식을 확인해 주세요.", kind: "invalid" };
  if (startMinutes === endMinutes) return { text: "저장 불가 · 시작과 종료 시간이 같습니다.", kind: "invalid" };
  const isOvernight = endMinutes < startMinutes;
  const durationMinutes = isOvernight ? endMinutes + 24 * 60 - startMinutes : endMinutes - startMinutes;
  const hours = Math.floor(durationMinutes / 60);
  const minutes = durationMinutes % 60;
  const durationLabel = [hours > 0 ? `${hours}시간` : "", minutes > 0 ? `${minutes}분` : ""].filter(Boolean).join(" ");
  return {
    text: `${isOvernight ? "익일" : "당일"} ${endTime} · ${durationLabel}`,
    kind: isOvernight ? "overnight" : "normal",
  };
}

interface TimeParts {
  period: "AM" | "PM";
  hour: number;
  minute: number;
}

interface TerminalTimePickerProps {
  label: string;
  value: string;
  fallbackValue: string;
  onChange: (value: string) => void;
  allowEmpty?: boolean;
  align?: "left" | "right";
}

const hourOptions = Array.from({ length: 12 }, (_, index) => index + 1);
const minuteOptions = Array.from({ length: 60 }, (_, index) => index);

/** Converts a stored 24-hour time into picker-friendly values. */
function parseTimeValue(value: string): TimeParts {
  const [hours = 0, minute = 0] = value.split(":").map(Number);
  return {
    period: hours >= 12 ? "PM" : "AM",
    hour: hours % 12 || 12,
    minute,
  };
}

/** Converts picker values back into the routine's HH:mm representation. */
function createTimeValue(parts: TimeParts): string {
  const hours = parts.period === "PM" ? (parts.hour % 12) + 12 : parts.hour % 12;
  return `${String(hours).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

/** Formats a stored time as a Korean twelve-hour display value. */
function formatTimeValue(value: string): string {
  if (!value) return "시간 없음";
  const parts = parseTimeValue(value);
  return `${parts.period === "AM" ? "오전" : "오후"} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

/** Formats a concrete local occurrence time for editing without UTC conversion. */
function formatDateTimeValue(value: Date): string {
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}

/** Renders the terminal time picker as an inline scrolling control in short landscape viewports. */
function TerminalTimePicker({ label, value, fallbackValue, onChange, allowEmpty = false, align = "left" }: TerminalTimePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [manualTime, setManualTime] = useState(value);
  const [manualTimeError, setManualTimeError] = useState("");
  const pickerRef = useRef<HTMLDivElement>(null);
  const parts = parseTimeValue(value || fallbackValue);

  useEffect(() => {
    if (!isOpen) return undefined;
    /** Closes the picker when pointer or focus interaction continues elsewhere in the routine form. */
    function closeOnOutsideInteraction(event: PointerEvent | FocusEvent) {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) setIsOpen(false);
    }
    /** Closes the picker with Escape without clearing the selected time. */
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setIsOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsideInteraction, true);
    document.addEventListener("focusin", closeOnOutsideInteraction, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideInteraction, true);
      document.removeEventListener("focusin", closeOnOutsideInteraction, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [isOpen]);

  /** Applies one picker column while preserving the other selected values. */
  function updateTime(change: Partial<TimeParts>) {
    const nextValue = createTimeValue({ ...parts, ...change });
    setManualTime(nextValue);
    setManualTimeError("");
    onChange(nextValue);
  }

  /** Opens or closes the picker while refreshing the direct-entry field from the saved value. */
  function togglePicker() {
    if (!isOpen) {
      setManualTime(value);
      setManualTimeError("");
    }
    setIsOpen((current) => !current);
  }

  /** Validates and applies a keyboard-entered 24-hour time, optionally closing the picker. */
  function applyManualTime(closeAfterApply = false): boolean {
    if (allowEmpty && manualTime.trim() === "") {
      onChange("");
      setManualTimeError("");
      if (closeAfterApply) setIsOpen(false);
      return true;
    }
    const normalized = normalizeTimeInput(manualTime);
    if (!normalized) {
      setManualTimeError("00:00~23:59 형식으로 입력해 주세요.");
      return false;
    }
    setManualTime(normalized);
    setManualTimeError("");
    onChange(normalized);
    if (closeAfterApply) setIsOpen(false);
    return true;
  }

  return (
    <div ref={pickerRef} className="relative min-w-0">
      <p className="text-sm font-bold">{label}</p>
      <button type="button" aria-haspopup="dialog" aria-expanded={isOpen} className="terminalField mt-2 flex items-center justify-between text-left" onClick={togglePicker}>
        <span>{formatTimeValue(value)}</span><span aria-hidden="true" className="text-[#1c7ba6]">⌄</span>
      </button>

      {isOpen && (
        <div role="dialog" aria-label={`${label} 시간 선택`} className={`absolute top-full z-50 mt-1 w-[min(20rem,calc(100vw-2rem))] border border-[#2fbffc] bg-[#02080d] p-3 shadow-[0_0_24px_#2fbffc44] phoneLandscape:static phoneLandscape:mt-2 phoneLandscape:w-full phoneLandscape:shadow-none ${align === "right" ? "right-0" : "left-0"}`}>
          <div className="mb-3 border border-[#165b80] bg-black p-2">
            <label className="block text-[10px] font-bold tracking-[.14em] text-[#1c7ba6]" htmlFor={`${label}-manual-time`}>직접 입력 / 24시간</label>
            <div className="mt-2 grid grid-cols-[minmax(0,1fr)_4rem] gap-2">
              <input
                id={`${label}-manual-time`}
                value={manualTime}
                inputMode="numeric"
                autoComplete="off"
                maxLength={5}
                placeholder="20:30"
                aria-invalid={Boolean(manualTimeError)}
                className="terminalField min-w-0 font-mono"
                onChange={(event) => { setManualTime(event.target.value); setManualTimeError(""); }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  applyManualTime();
                }}
              />
              <button type="button" className="outlineButton min-h-10 px-2 text-xs" onClick={() => applyManualTime()}>적용</button>
            </div>
            {manualTimeError && <p role="alert" className="mt-2 text-[10px] text-[#e0717d]">{manualTimeError}</p>}
            <p className="mt-2 text-[9px] text-[#31536a]">예: 20:30 또는 2030</p>
          </div>
          <div className="mb-2 grid grid-cols-[72px_1fr_1fr] gap-2 text-center text-[10px] font-bold tracking-[.14em] text-[#1c7ba6]"><span>구분</span><span>시</span><span>분</span></div>
          <div className="grid grid-cols-[72px_1fr_1fr] gap-2">
            <div className="space-y-1">
              {(["AM", "PM"] as const).map((period) => (
                <button type="button" key={period} className={`min-h-10 w-full border text-xs font-bold ${parts.period === period ? "border-[#2fbffc] bg-[#2fbffc] text-black" : "border-[#165b80] text-[#5cd0ff] hover:bg-[#072233]"}`} onClick={() => updateTime({ period })}>{period === "AM" ? "오전" : "오후"}</button>
              ))}
            </div>
            <div className="max-h-44 space-y-1 overflow-y-auto pr-1 phoneLandscape:max-h-24">
              {hourOptions.map((hour) => (
                <button type="button" key={hour} className={`min-h-9 w-full border text-xs ${parts.hour === hour ? "border-[#2fbffc] bg-[#072233] font-bold text-[#5cd0ff]" : "border-[#0d3043] text-[#1c7ba6] hover:border-[#2fbffc]"}`} onClick={() => updateTime({ hour })}>{String(hour).padStart(2, "0")}</button>
              ))}
            </div>
            <div className="max-h-44 space-y-1 overflow-y-auto pr-1 phoneLandscape:max-h-24">
              {minuteOptions.map((minute) => (
                <button type="button" key={minute} className={`min-h-9 w-full border text-xs ${parts.minute === minute ? "border-[#2fbffc] bg-[#072233] font-bold text-[#5cd0ff]" : "border-[#0d3043] text-[#1c7ba6] hover:border-[#2fbffc]"}`} onClick={() => updateTime({ minute })}>{String(minute).padStart(2, "0")}</button>
              ))}
            </div>
          </div>
          <div className={`mt-3 grid gap-2 ${allowEmpty ? "grid-cols-2" : "grid-cols-1"}`}>
            {allowEmpty && <button type="button" className="outlineButton min-h-10" onClick={() => { setManualTime(""); setManualTimeError(""); onChange(""); setIsOpen(false); }}>시간 없음</button>}
            <button type="button" className="terminalButton min-h-10" onClick={() => applyManualTime(true)}>확인</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Presents weekday routines with compact landscape rows and a height-bounded creation dialog. */
export default function SchedulePage() {
  const { state, addIdealRoutine, updateIdealRoutine, applyIdealRoutineBatch, toggleIdealRoutine, removeIdealRoutine, restoreIdealRoutine } = useLocalState();
  const [selectedRoutineDay, setSelectedRoutineDay] = useState(() => new Date().getDay());
  const [isRoutineModalOpen, setIsRoutineModalOpen] = useState(false);
  const [editingRoutineId, setEditingRoutineId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [routineError, setRoutineError] = useState("");
  const [routineTitle, setRoutineTitle] = useState("");
  const [routineStart, setRoutineStart] = useState("20:00");
  const [routineEnd, setRoutineEnd] = useState("20:30");
  const [routineDays, setRoutineDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [routineCategory, setRoutineCategory] = useState<IdealRoutine["category"]>("personal");
  const [routinePriority, setRoutinePriority] = useState(3);
  const [routineTimingMode, setRoutineTimingMode] = useState<RoutineTimingMode>("FIXED");
  const [routineSteps, setRoutineSteps] = useState<RoutineStep[]>([]);
  const [routineConstraints, setRoutineConstraints] = useState<ExecutionConstraints>();
  const [isRoutineStepsOpen, setIsRoutineStepsOpen] = useState(false);
  const [routineLocked, setRoutineLocked] = useState(false);
  const [routineEditScope, setRoutineEditScope] = useState<RoutineEditScope>("RECURRING");
  const [shiftPreview, setShiftPreview] = useState<RoutineShiftPreview | null>(null);
  const [isAutoShiftEnabled, setIsAutoShiftEnabled] = useState(false);
  const [isMidnightConfirmed, setIsMidnightConfirmed] = useState(false);
  const [overlapConfirmationKey, setOverlapConfirmationKey] = useState<string | null>(null);
  const [overlapWarning, setOverlapWarning] = useState("");
  const [deletedRoutine, setDeletedRoutine] = useState<IdealRoutine | null>(null);
  const deletionTimerRef = useRef<number | null>(null);
  const routineTimeNotice = describeRoutineTime(routineStart, routineEnd || undefined);

  useEffect(() => {
    setOverlapConfirmationKey(null);
    setOverlapWarning("");
    setShiftPreview(null);
    setIsAutoShiftEnabled(false);
    setIsMidnightConfirmed(false);
  }, [routineTitle, routineStart, routineEnd, routineDays, routineCategory, routinePriority, routineTimingMode, routineSteps, routineLocked, routineEditScope, routineConstraints]);

  useEffect(() => () => {
    if (deletionTimerRef.current !== null) window.clearTimeout(deletionTimerRef.current);
  }, []);

  /** Opens the routine modal with the currently viewed weekday included. */
  function openRoutineModal() {
    setEditingRoutineId(null);
    setRoutineTitle("");
    setRoutineStart("20:00");
    setRoutineEnd("20:30");
    setRoutineDays([selectedRoutineDay]);
    setRoutineCategory("personal");
    setRoutinePriority(3);
    setRoutineTimingMode("FIXED");
    setRoutineSteps([]);
    setRoutineConstraints(undefined);
    setIsRoutineStepsOpen(false);
    setRoutineLocked(false);
    setRoutineEditScope("RECURRING");
    setShiftPreview(null);
    setIsAutoShiftEnabled(false);
    setIsMidnightConfirmed(false);
    setOverlapConfirmationKey(null);
    setOverlapWarning("");
    setRoutineError("");
    setIsRoutineModalOpen(true);
  }

  /** Opens the shared routine dialog with one saved routine loaded for editing. */
  function openRoutineEditor(routine: IdealRoutine) {
    setEditingRoutineId(routine.id);
    setRoutineTitle(routine.title);
    setRoutineStart(routine.startTime);
    setRoutineEnd(routine.endTime ?? "");
    setRoutineDays(routine.daysOfWeek);
    setRoutineCategory(routine.category);
    setRoutinePriority(routine.priority);
    setRoutineTimingMode(routine.timingMode);
    setRoutineConstraints(routine.executionConstraints);
    const steps = (routine.steps ?? []).map((step) => ({ ...step }));
    setRoutineSteps(steps);
    setIsRoutineStepsOpen(steps.length > 0);
    setRoutineLocked(Boolean(routine.locked));
    setRoutineEditScope("RECURRING");
    setShiftPreview(null);
    setIsAutoShiftEnabled(false);
    setIsMidnightConfirmed(false);
    setOverlapConfirmationKey(null);
    setOverlapWarning("");
    setRoutineError("");
    setIsRoutineModalOpen(true);
  }

  /** Switches between recurring-template and today-only time editing with explicit field values. */
  function changeRoutineEditScope(scope: RoutineEditScope) {
    if (!editingRoutineId || !state) return;
    const routine = state.idealRoutines.find((item) => item.id === editingRoutineId);
    if (!routine) return;
    if (scope === "TODAY") {
      const today = new Date();
      const occurrence = getRoutineWindow(routine, today);
      if (!occurrence) {
        setRoutineError("이 루틴은 오늘 발생하지 않아 오늘만 변경할 수 없습니다.");
        return;
      }
      const override = routine.dateOverrides?.find((item) => item.dateKey === formatLocalDateKey(today));
      setRoutineStart(formatDateTimeValue(occurrence.startAt));
      setRoutineEnd((override ? override.endTime : routine.endTime) ? formatDateTimeValue(occurrence.endAt) : "");
    } else {
      setRoutineStart(routine.startTime);
      setRoutineEnd(routine.endTime ?? "");
    }
    setRoutineError("");
    setRoutineEditScope(scope);
  }

  /** Saves a validated ideal routine and closes the creation modal. */
  async function handleAddRoutine(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRoutineError("");
    try {
      const existingRoutine = editingRoutineId
        ? state?.idealRoutines.find((routine) => routine.id === editingRoutineId)
        : undefined;
      const draft = {
        title: routineTitle,
        startTime: routineStart,
        endTime: routineEnd || undefined,
        daysOfWeek: routineDays,
        category: routineCategory,
        priority: routinePriority,
        enabled: existingRoutine?.enabled ?? true,
        locked: existingRoutine ? routineLocked : false,
        timingMode: routineTimingMode,
        steps: routineSteps,
        executionConstraints: routineConstraints,
        dateOverrides: existingRoutine?.dateOverrides ?? [],
      } satisfies Omit<IdealRoutine, "id">;
      const confirmationKey = JSON.stringify([draft, routineEditScope]);
      const overlapConflicts = getRoutineOverlapConflicts(state?.idealRoutines ?? [], draft, editingRoutineId ?? undefined);
      let error: string | null;
      if (editingRoutineId && existingRoutine && state) {
        const editedRoutine: IdealRoutine = { ...draft, id: editingRoutineId };
        const preview = shiftPreview ?? createRoutineShiftPreview(
          state.idealRoutines,
          existingRoutine,
          editedRoutine,
          routineEditScope,
          new Date(),
        );
        if (preview.hasConflict && overlapConfirmationKey !== confirmationKey) {
          setShiftPreview(preview);
          setOverlapConfirmationKey(confirmationKey);
          setOverlapWarning(`시간이 겹치는 루틴: ${preview.conflictingRoutineTitles.join(", ")} · 자동 밀기 결과를 확인해 주세요.`);
          return;
        }
        if (preview.hasConflict && isAutoShiftEnabled) {
          if (preview.blockedReasons.length > 0) {
            setRoutineError(preview.blockedReasons.join(" / "));
            return;
          }
          if (preview.crossesMidnight && !isMidnightConfirmed) {
            setRoutineError("자정을 넘는 이동을 확인해 주세요.");
            return;
          }
          error = await applyIdealRoutineBatch(preview.updatedRoutines);
        } else if (routineEditScope === "TODAY") {
          if (preview.hasConflict) {
            setRoutineError("오늘만 변경에서 겹침이 발생하면 뒤 루틴 자동 밀기를 사용해 주세요.");
            return;
          }
          error = await applyIdealRoutineBatch(preview.updatedRoutines);
        } else {
          error = await updateIdealRoutine(editingRoutineId, draft);
        }
      } else {
        if (overlapConflicts.length > 0 && overlapConfirmationKey !== confirmationKey) {
          setOverlapConfirmationKey(confirmationKey);
          setOverlapWarning(`시간이 겹치는 루틴: ${overlapConflicts.map(({ routine }) => routine.title).join(", ")} · 의도한 겹침이면 저장을 한 번 더 누르세요.`);
          return;
        }
        error = await addIdealRoutine(draft);
      }
      if (error) { setRoutineError(error); return; }
      setRoutineTitle("");
      setIsRoutineModalOpen(false);
      setMessage(editingRoutineId
        ? routineEditScope === "TODAY"
          ? "오늘 루틴 시간을 수정하고 알림을 다시 예약했습니다."
          : isAutoShiftEnabled
            ? "뒤 루틴을 미리보기대로 이동하고 알림을 다시 예약했습니다."
            : "루틴을 수정했습니다."
        : "반복 루틴을 저장했습니다.");
      setEditingRoutineId(null);
    } catch {
      setRoutineError("루틴을 저장하지 못했습니다.");
    }
  }

  /** Adds one optional detailed action without changing the parent routine schedule. */
  function addRoutineStep() {
    setRoutineSteps((current) => current.length >= 20 ? current : [...current, createRoutineStepDraft()]);
  }

  /** Updates one detailed action while preserving its stable identity and list position. */
  function updateRoutineStep(stepId: string, change: Partial<Omit<RoutineStep, "id">>) {
    setRoutineSteps((current) => current.map((step) => step.id === stepId ? { ...step, ...change } : step));
  }

  /** Removes one optional detailed action from the parent routine. */
  function removeRoutineStep(stepId: string) {
    setRoutineSteps((current) => current.filter((step) => step.id !== stepId));
  }

  /** Moves one detailed action without regenerating IDs used by routine progress history. */
  function moveRoutineStep(stepId: string, offset: -1 | 1) {
    setRoutineSteps((current) => {
      const index = current.findIndex((step) => step.id === stepId);
      const targetIndex = index + offset;
      if (index < 0 || targetIndex < 0 || targetIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      return next;
    });
  }

  /** Deletes one Routine immediately and keeps its original identity available for five-second recovery. */
  async function handleRemoveRoutine(routine: IdealRoutine) {
    await removeIdealRoutine(routine.id);
    if (deletionTimerRef.current !== null) window.clearTimeout(deletionTimerRef.current);
    setDeletedRoutine(routine);
    deletionTimerRef.current = window.setTimeout(() => {
      setDeletedRoutine(null);
      deletionTimerRef.current = null;
    }, 5_000);
  }

  /** Restores the latest deleted Routine unless its weekday and start time now conflict. */
  async function handleUndoRoutineDeletion() {
    if (!deletedRoutine) return;
    if (deletionTimerRef.current !== null) window.clearTimeout(deletionTimerRef.current);
    deletionTimerRef.current = null;
    const routine = deletedRoutine;
    setDeletedRoutine(null);
    const error = await restoreIdealRoutine(routine);
    setMessage(error ?? `‘${routine.title}’ 루틴을 복원했습니다.`);
  }

  if (!state) return <p role="status">데이터를 불러오는 중…</p>;
  const selectedDayRoutines = state.idealRoutines
    .filter((routine) => routine.daysOfWeek.includes(selectedRoutineDay))
    .sort((left, right) => left.startTime.localeCompare(right.startTime));

  return (
    <div className="w-full">
      <PageHeading code="ROUTINE PATH" title="반복 루틴" description="요일별 행동을 시간순으로 연결해 평소 지키고 싶은 생활 흐름을 설정합니다." />

      <section aria-label="요일별 반복 루틴" className="mx-auto max-w-4xl border border-[#165b80] bg-[#02080d]">
        <div className="grid grid-cols-7 border-b border-[#165b80] bg-black p-2">
          {weekdays.map((day) => (
            <button
              type="button"
              key={day.value}
              aria-pressed={selectedRoutineDay === day.value}
              onClick={() => setSelectedRoutineDay(day.value)}
              className={`min-h-14 border text-sm font-bold transition-colors phoneLandscape:min-h-11 ${selectedRoutineDay === day.value ? "border-[#2fbffc] bg-[#2fbffc] text-black shadow-[0_0_10px_#2fbffc66]" : "border-[#165b80] bg-[#050e18] text-[#1c7ba6] hover:bg-[#072233] hover:text-[#5cd0ff]"}`}
            >
              {day.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#165b80] px-5 py-4 phoneLandscape:py-3">
          <div className="text-xs tracking-[.15em] text-[#1c7ba6]">
            <span>DAILY ROUTE / {weekdays.find((day) => day.value === selectedRoutineDay)?.label}</span>
            <span className="ml-3">{selectedDayRoutines.length} STEPS</span>
          </div>
          <button type="button" className="min-h-10 border border-[#2fbffc] px-4 text-xs font-bold text-[#5cd0ff] hover:bg-[#072233]" onClick={openRoutineModal}>+ 루틴 추가</button>
        </div>

        {selectedDayRoutines.length === 0 ? (
          <div className="px-5 py-14 text-center phoneLandscape:py-8">
            <p className="text-sm text-[#567287]">이 요일에 설정된 루틴이 없습니다.</p>
            <p className="mt-2 text-xs text-[#1c7ba6]">루틴 추가 버튼을 눌러 첫 행동을 연결하세요.</p>
          </div>
        ) : (
          <div className="relative">
            <span aria-hidden="true" className="absolute bottom-10 left-[5.75rem] top-10 w-px bg-[#165b80] shadow-[0_0_8px_#2fbffc55] sm:left-[7rem]" />
            <ol className="px-4 py-5 sm:px-5">
              {selectedDayRoutines.map((routine, index) => (
                <li key={routine.id} className={`relative grid grid-cols-[58px_20px_minmax(0,1fr)] items-stretch gap-2 pb-4 last:pb-0 sm:grid-cols-[68px_24px_minmax(0,1fr)] sm:gap-3 phoneLandscape:pb-3 ${routine.enabled ? "" : "opacity-45"}`}>
                  <div className="pt-3 text-right">
                    <p className="text-xs font-bold text-[#5cd0ff]">{routine.startTime}</p>
                    {routine.endTime && (() => {
                      const notice = describeRoutineTime(routine.startTime, routine.endTime);
                      return <p className={`mt-1 text-[10px] ${notice.kind === "invalid" ? "text-[#e0717d]" : notice.kind === "overnight" ? "text-[#f0bc77]" : "text-[#1c7ba6]"}`}>{notice.text}</p>;
                    })()}
                  </div>
                  <div className="relative flex justify-center pt-4">
                    <span aria-hidden="true" className={`relative z-10 h-3 w-3 border-2 ${index === 0 ? "border-[#5cd0ff] bg-[#2fbffc] shadow-[0_0_10px_#2fbffc]" : "border-[#2fbffc] bg-black"}`} />
                  </div>
                  <div className="flex min-h-16 items-start gap-3 border border-[#165b80] bg-[#050e18] px-3 py-3 shadow-[inset_4px_0_0_#2fbffc] sm:px-4">
                    <input aria-label={`${routine.title} 활성화`} type="checkbox" checked={routine.enabled} onChange={() => void toggleIdealRoutine(routine.id)} className="mt-1 h-5 w-5 shrink-0 accent-[#2fbffc]" />
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => openRoutineEditor(routine)} aria-label={`${routine.title} 수정`}>
                      <p className="truncate font-semibold text-[#5cd0ff]">{routine.title}</p>
                      <p className="mt-1 text-[11px] text-[#1c7ba6]">{formatRoutineCategory(routine.category)} · {routine.timingMode === "FIXED" ? "고정형" : "유연형"} · 우선순위 {routine.priority} · {(routine.steps?.length ?? 0) > 0 ? `상세 ${routine.steps?.length}단계` : "단일 행동"}{routine.locked ? " · 잠금" : ""}</p>
                    </button>
                    <button type="button" aria-label={`${routine.title} 삭제`} className="min-h-8 border border-[#165b80] px-2 text-[10px] text-[#1c7ba6] hover:border-[#2fbffc] hover:text-[#5cd0ff]" onClick={() => void handleRemoveRoutine(routine)}>삭제</button>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}
      </section>

      {message && <p role="status" className="mx-auto mt-5 max-w-4xl text-sm text-[#5cd0ff]">{message}</p>}

      {isRoutineModalOpen && (
        <div data-pin-terminal-navigation="true" className="terminalDialogOverlay fixed inset-0 z-30 flex items-end justify-center bg-black/80 sm:items-center phoneLandscape:items-start" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsRoutineModalOpen(false); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="routineDialogTitle" className="terminalDialogPanel w-full max-w-lg border border-[#2fbffc] bg-[#071320] p-5 text-[#5cd0ff] shadow-[0_0_32px_#2fbffc44] sm:p-6 phoneLandscape:max-w-2xl phoneLandscape:p-4">
            <div className="mb-5 flex items-start justify-between gap-4 border-b border-[#165b80] pb-4">
              <div>
                <p className="text-[10px] tracking-[.18em] text-[#1c7ba6]">{editingRoutineId ? "EDIT ROUTINE" : "NEW ROUTINE"}</p>
                <h2 id="routineDialogTitle" className="mt-1 text-xl font-bold">{editingRoutineId ? "루틴 수정" : "새 루틴"}</h2>
              </div>
              <button type="button" aria-label="루틴 설정 창 닫기" className="h-9 w-9 border border-[#165b80] text-lg text-[#2fbffc] hover:border-[#2fbffc] hover:bg-[#072233]" onClick={() => setIsRoutineModalOpen(false)}>×</button>
            </div>
            <form onSubmit={handleAddRoutine} className="space-y-4 phoneLandscape:grid phoneLandscape:grid-cols-2 phoneLandscape:gap-3 phoneLandscape:space-y-0">
              {routineError && <p role="alert" className="border border-[#2fbffc] bg-[#02080d] px-3 py-3 text-sm font-bold text-[#8edfff] shadow-[inset_3px_0_0_#2fbffc] phoneLandscape:col-span-2">ERROR / {routineError}</p>}
              {overlapWarning && <p role="alert" className="border border-[#e0a55b] bg-[#120d08] px-3 py-3 text-sm font-bold text-[#f0bc77] shadow-[inset_3px_0_0_#e0a55b] phoneLandscape:col-span-2">OVERLAP / {overlapWarning}</p>}
              {shiftPreview && (
                <section className="space-y-3 border border-[#e0a55b] bg-[#120d08] p-3 text-[#f0bc77] phoneLandscape:col-span-2" aria-label="뒤 루틴 자동 밀기 미리보기">
                  <label className="flex cursor-pointer items-center gap-3 text-sm font-bold">
                    <input type="checkbox" checked={isAutoShiftEnabled} className="h-5 w-5 accent-[#e0a55b]" onChange={(event) => { setIsAutoShiftEnabled(event.target.checked); setRoutineError(""); }} />
                    뒤 루틴 자동 밀기
                  </label>
                  <p className="text-[11px] leading-5 text-[#a77f52]">{shiftPreview.scope === "TODAY" ? `${shiftPreview.dateKey} 하루만` : "반복 요일 전체"} · 종료 변화 {shiftPreview.deltaMinutes >= 0 ? "+" : ""}{shiftPreview.deltaMinutes}분 · 현재 ACTIVE 지령은 유지됩니다.</p>
                  {isAutoShiftEnabled && (
                    <div className="space-y-2 border-t border-[#7a562e] pt-3">
                      {shiftPreview.changes.map((change) => (
                        <div key={change.routineId} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-[11px]">
                          <span className="truncate">{change.isEditedRoutine ? "수정" : "이동"} / {change.title}</span>
                          <span className="text-right font-mono">{change.beforeStartTime}~{change.beforeEndTime ?? "+30m"} → {change.startDayOffset === 1 ? "익일 " : ""}{change.afterStartTime}~{change.afterEndTime ?? "+30m"}</span>
                          {change.beforeDays.join(",") !== change.afterDays.join(",") && (
                            <span className="col-span-2 text-right text-[#a77f52]">요일 {formatRoutineWeekdays(change.beforeDays)} → {formatRoutineWeekdays(change.afterDays)}</span>
                          )}
                        </div>
                      ))}
                      {shiftPreview.lockedRoutineTitles.length > 0 && <p className="text-[11px] text-[#e0717d]">잠금으로 이동 제외: {shiftPreview.lockedRoutineTitles.join(", ")}</p>}
                      {shiftPreview.blockedReasons.map((reason) => <p key={reason} role="alert" className="text-[11px] font-bold text-[#e0717d]">{reason}</p>)}
                      {shiftPreview.crossesMidnight && (
                        <label className="flex cursor-pointer items-center gap-2 border border-[#e0717d] px-3 py-2 text-[11px] text-[#f09aa3]">
                          <input type="checkbox" checked={isMidnightConfirmed} className="accent-[#e0717d]" onChange={(event) => setIsMidnightConfirmed(event.target.checked)} />
                          자정을 넘거나 익일로 이동하는 결과를 확인했습니다.
                        </label>
                      )}
                    </div>
                  )}
                </section>
              )}
              <label className="block text-sm font-bold phoneLandscape:col-span-2">루틴명<input autoFocus required disabled={routineEditScope === "TODAY"} maxLength={120} value={routineTitle} onChange={(event) => setRoutineTitle(event.target.value)} className="terminalField mt-2 disabled:opacity-45" /></label>
              {routineEditScope === "RECURRING" && <div className="phoneLandscape:col-span-2"><ExecutionConstraintsEditor value={routineConstraints} onChange={setRoutineConstraints} /></div>}
              {editingRoutineId && (
                <fieldset className="phoneLandscape:col-span-2">
                  <legend className="mb-2 text-sm font-bold">수정 범위</legend>
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" aria-pressed={routineEditScope === "RECURRING"} className={`min-h-12 border px-3 text-sm font-bold ${routineEditScope === "RECURRING" ? "border-[#2fbffc] bg-[#072233]" : "border-[#165b80] text-[#567287]"}`} onClick={() => changeRoutineEditScope("RECURRING")}>반복 전체</button>
                    <button type="button" aria-pressed={routineEditScope === "TODAY"} className={`min-h-12 border px-3 text-sm font-bold ${routineEditScope === "TODAY" ? "border-[#2fbffc] bg-[#072233]" : "border-[#165b80] text-[#567287]"}`} onClick={() => changeRoutineEditScope("TODAY")}>오늘 하루만</button>
                  </div>
                  {routineEditScope === "TODAY" && <p className="mt-2 text-[10px] leading-4 text-[#567287]">오늘만 수정에서는 시간과 자동 밀기 결과만 저장하며 반복 템플릿은 유지합니다.</p>}
                </fieldset>
              )}
              {routineEditScope === "RECURRING" && <details key={`${editingRoutineId ?? "new"}-${isRoutineModalOpen ? "open" : "closed"}`} open={isRoutineStepsOpen} className="border border-[#165b80] bg-[#02080d] phoneLandscape:col-span-2" onToggle={(event) => setIsRoutineStepsOpen(event.currentTarget.open)}>
                <summary className="cursor-pointer px-3 py-3 text-sm font-bold text-[#5cd0ff]">상세 단계 {routineSteps.length > 0 ? `/ ${routineSteps.length}` : "/ 선택 사항"}</summary>
                <div className="space-y-3 border-t border-[#165b80] p-3">
                  <p className="text-[11px] leading-5 text-[#567287]">단계는 한 번에 하나씩 지령으로 발행됩니다. 상위 루틴명과 진행 단계는 메인 화면이 아닌 ⓘ에서만 확인할 수 있습니다.</p>
                  {routineSteps.map((step, index) => (
                    <div key={step.id} className="border border-[#0d3043] bg-black p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="text-[10px] font-bold tracking-[.16em] text-[#1c7ba6]">STEP {index + 1}</span>
                        <div className="flex gap-1">
                          <button type="button" aria-label={`${index + 1}단계 위로 이동`} disabled={index === 0} className="h-8 w-8 border border-[#165b80] text-xs disabled:opacity-25" onClick={() => moveRoutineStep(step.id, -1)}>↑</button>
                          <button type="button" aria-label={`${index + 1}단계 아래로 이동`} disabled={index === routineSteps.length - 1} className="h-8 w-8 border border-[#165b80] text-xs disabled:opacity-25" onClick={() => moveRoutineStep(step.id, 1)}>↓</button>
                          <button type="button" aria-label={`${index + 1}단계 삭제`} className="h-8 border border-[#165b80] px-2 text-[10px] text-[#e0717d]" onClick={() => removeRoutineStep(step.id)}>삭제</button>
                        </div>
                      </div>
                      <label className="block text-xs font-bold">행동 문구<input required maxLength={160} value={step.title} placeholder="예: 운동복으로 갈아입을 것" className="terminalField mt-2" onChange={(event) => updateRoutineStep(step.id, { title: event.target.value })} /></label>
                      <ExecutionConstraintsEditor value={step.executionConstraints} onChange={(executionConstraints) => updateRoutineStep(step.id, { executionConstraints })} />
                      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
                        <label className="block text-xs font-bold">행동 유형<select value={step.actionType} className="terminalField mt-2" onChange={(event) => updateRoutineStep(step.id, { actionType: event.target.value as RoutineActionType })}>{routineActionTypes.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                        <label className="block text-xs font-bold">예상 분<input required type="number" min="1" max="120" value={step.expectedMinutes} className="terminalField mt-2" onChange={(event) => updateRoutineStep(step.id, { expectedMinutes: Number(event.target.value) })} /></label>
                      </div>
                      <p className="mt-2 text-[10px] text-[#31536a]">{routineActionTypes.find((option) => option.value === step.actionType)?.description}</p>
                    </div>
                  ))}
                  <button type="button" disabled={routineSteps.length >= 20} className="outlineButton w-full disabled:opacity-40" onClick={addRoutineStep}>+ 단계 추가</button>
                </div>
              </details>}
              <div className="grid grid-cols-2 gap-3 phoneLandscape:col-span-2">
                <TerminalTimePicker label="시작" value={routineStart} fallbackValue="20:00" onChange={setRoutineStart} />
                <TerminalTimePicker label="종료" value={routineEnd} fallbackValue="20:30" onChange={setRoutineEnd} allowEmpty align="right" />
              </div>
              <p role="status" className={`border-l pl-3 text-xs leading-5 phoneLandscape:col-span-2 ${routineTimeNotice.kind === "invalid" ? "border-[#e0717d] text-[#e0717d]" : routineTimeNotice.kind === "overnight" ? "border-[#e0a55b] text-[#f0bc77]" : "border-[#165b80] text-[#567287]"}`}>
                {routineTimeNotice.text}
              </p>
              {routineEditScope === "RECURRING" && <fieldset className="min-w-0 phoneLandscape:col-span-2">
                <legend className="mb-2 text-sm font-bold">시간 유형</legend>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { value: "FIXED" as const, label: "고정형", description: "시작 시각을 Planner 경계로 사용" },
                    { value: "FLEXIBLE" as const, label: "유연형", description: "시간대 안에서 후보로만 사용" },
                  ]).map((option) => (
                    <button key={option.value} type="button" aria-pressed={routineTimingMode === option.value} className={`min-h-16 border px-3 py-2 text-left ${routineTimingMode === option.value ? "border-[#2fbffc] bg-[#072233] text-[#5cd0ff]" : "border-[#165b80] text-[#567287]"}`} onClick={() => setRoutineTimingMode(option.value)}>
                      <span className="block text-sm font-bold">{option.label}</span>
                      <span className="mt-1 block text-[10px] leading-4">{option.description}</span>
                    </button>
                  ))}
                </div>
              </fieldset>}
              {routineEditScope === "RECURRING" && <WeekdaySelector selected={routineDays} onChange={setRoutineDays} />}
              {routineEditScope === "RECURRING" && <label className="block text-sm font-bold">분류<select value={routineCategory} onChange={(event) => setRoutineCategory(event.target.value as IdealRoutine["category"])} className="terminalField mt-2">{routineCategories.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>}
              {routineEditScope === "RECURRING" && <label className="block text-sm font-bold">우선순위<select value={routinePriority} onChange={(event) => setRoutinePriority(Number(event.target.value))} className="terminalField mt-2">{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>}
              {routineEditScope === "RECURRING" && <label className="flex min-h-12 cursor-pointer items-center gap-3 border border-[#165b80] px-3 text-sm font-bold phoneLandscape:col-span-2">
                <input type="checkbox" checked={routineLocked} className="h-5 w-5 accent-[#2fbffc]" onChange={(event) => setRoutineLocked(event.target.checked)} />
                고정·잠금 루틴으로 설정 <span className="text-[10px] font-normal text-[#567287]">자동 밀기 대상에서 제외</span>
              </label>}
              <div className="grid grid-cols-2 gap-3 pt-2 phoneLandscape:col-span-2">
                <button type="button" className="outlineButton" onClick={() => setIsRoutineModalOpen(false)}>취소</button>
                <button type="submit" className="terminalButton">{shiftPreview && isAutoShiftEnabled ? "미리보기대로 일괄 적용" : routineEditScope === "TODAY" ? "오늘만 적용" : overlapConfirmationKey ? "겹침 허용하고 저장" : editingRoutineId ? "수정 저장" : "루틴 추가"}</button>
              </div>
            </form>
          </section>
        </div>
      )}
      {deletedRoutine && <DeletionUndoToast label={`‘${deletedRoutine.title}’ 루틴을 삭제했습니다.`} onUndo={() => void handleUndoRoutineDeletion()} />}
    </div>
  );
}

/** Renders accessible weekday toggles for routine creation. */
function WeekdaySelector({ selected, onChange }: { selected: number[]; onChange: (days: number[]) => void }) {
  return (
    <fieldset className="min-w-0 phoneLandscape:col-span-2">
      <legend className="mb-2 text-sm font-bold">요일</legend>
      <div className="grid grid-cols-7 gap-1">
        {weekdays.map((day) => (
          <label key={day.value} className={`flex min-h-10 cursor-pointer items-center justify-center border text-sm ${selected.includes(day.value) ? "border-[#2fbffc] bg-[#2fbffc] text-black shadow-[0_0_8px_#2fbffc55]" : "border-[#165b80] text-[#1c7ba6]"}`}>
            <input type="checkbox" className="sr-only" checked={selected.includes(day.value)} onChange={() => onChange(toggleWeekday(selected, day.value))} />{day.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
