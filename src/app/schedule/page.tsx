"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { PageHeading } from "@/components/PageHeading";
import { useLocalState } from "@/lib/localState";
import type { IdealRoutine } from "@/lib/ticketMachine";

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

/** Toggles one weekday while keeping the values unique. */
function toggleWeekday(days: number[], day: number): number[] {
  return days.includes(day) ? days.filter((value) => value !== day) : [...days, day];
}

/** Returns the Korean label for one routine category. */
function formatRoutineCategory(category: IdealRoutine["category"]): string {
  return routineCategories.find((item) => item.value === category)?.label ?? "기타";
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

/** Renders the terminal time picker as an inline scrolling control in short landscape viewports. */
function TerminalTimePicker({ label, value, fallbackValue, onChange, allowEmpty = false, align = "left" }: TerminalTimePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const parts = parseTimeValue(value || fallbackValue);

  useEffect(() => {
    if (!isOpen) return undefined;
    /** Closes the picker when the user continues elsewhere in the routine form. */
    function closeOnOutsidePointer(event: PointerEvent) {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) setIsOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [isOpen]);

  /** Applies one picker column while preserving the other selected values. */
  function updateTime(change: Partial<TimeParts>) {
    onChange(createTimeValue({ ...parts, ...change }));
  }

  return (
    <div ref={pickerRef} className="relative min-w-0">
      <p className="text-sm font-bold">{label}</p>
      <button type="button" aria-haspopup="dialog" aria-expanded={isOpen} className="terminalField mt-2 flex items-center justify-between text-left" onClick={() => setIsOpen((current) => !current)}>
        <span>{formatTimeValue(value)}</span><span aria-hidden="true" className="text-[#1c7ba6]">⌄</span>
      </button>

      {isOpen && (
        <div role="dialog" aria-label={`${label} 시간 선택`} className={`absolute top-full z-50 mt-1 w-[min(20rem,calc(100vw-2rem))] border border-[#2fbffc] bg-[#02080d] p-3 shadow-[0_0_24px_#2fbffc44] phoneLandscape:static phoneLandscape:mt-2 phoneLandscape:w-full phoneLandscape:shadow-none ${align === "right" ? "right-0" : "left-0"}`}>
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
            {allowEmpty && <button type="button" className="outlineButton min-h-10" onClick={() => { onChange(""); setIsOpen(false); }}>시간 없음</button>}
            <button type="button" className="terminalButton min-h-10" onClick={() => setIsOpen(false)}>확인</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Presents weekday routines with compact landscape rows and a height-bounded creation dialog. */
export default function SchedulePage() {
  const { state, addIdealRoutine, updateIdealRoutine, toggleIdealRoutine, removeIdealRoutine } = useLocalState();
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

  /** Opens the routine modal with the currently viewed weekday included. */
  function openRoutineModal() {
    setEditingRoutineId(null);
    setRoutineTitle("");
    setRoutineStart("20:00");
    setRoutineEnd("20:30");
    setRoutineDays([selectedRoutineDay]);
    setRoutineCategory("personal");
    setRoutinePriority(3);
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
    setRoutineError("");
    setIsRoutineModalOpen(true);
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
      } satisfies Omit<IdealRoutine, "id">;
      const error = editingRoutineId
        ? await updateIdealRoutine(editingRoutineId, draft)
        : await addIdealRoutine(draft);
      if (error) { setRoutineError(error); return; }
      setRoutineTitle("");
      setIsRoutineModalOpen(false);
      setMessage(editingRoutineId ? "루틴을 수정했습니다." : "반복 루틴을 저장했습니다.");
      setEditingRoutineId(null);
    } catch {
      setRoutineError("루틴을 저장하지 못했습니다.");
    }
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
                    {routine.endTime && <p className="mt-1 text-[10px] text-[#1c7ba6]">{routine.endTime}</p>}
                  </div>
                  <div className="relative flex justify-center pt-4">
                    <span aria-hidden="true" className={`relative z-10 h-3 w-3 border-2 ${index === 0 ? "border-[#5cd0ff] bg-[#2fbffc] shadow-[0_0_10px_#2fbffc]" : "border-[#2fbffc] bg-black"}`} />
                  </div>
                  <div className="flex min-h-16 items-start gap-3 border border-[#165b80] bg-[#050e18] px-3 py-3 shadow-[inset_4px_0_0_#2fbffc] sm:px-4">
                    <input aria-label={`${routine.title} 활성화`} type="checkbox" checked={routine.enabled} onChange={() => void toggleIdealRoutine(routine.id)} className="mt-1 h-5 w-5 shrink-0 accent-[#2fbffc]" />
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => openRoutineEditor(routine)} aria-label={`${routine.title} 수정`}>
                      <p className="truncate font-semibold text-[#5cd0ff]">{routine.title}</p>
                      <p className="mt-1 text-[11px] text-[#1c7ba6]">{formatRoutineCategory(routine.category)} · 우선순위 {routine.priority}</p>
                    </button>
                    <button type="button" aria-label={`${routine.title} 삭제`} className="min-h-8 border border-[#165b80] px-2 text-[10px] text-[#1c7ba6] hover:border-[#2fbffc] hover:text-[#5cd0ff]" onClick={() => void removeIdealRoutine(routine.id)}>삭제</button>
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
              <label className="block text-sm font-bold phoneLandscape:col-span-2">루틴명<input autoFocus required maxLength={120} value={routineTitle} onChange={(event) => setRoutineTitle(event.target.value)} className="terminalField mt-2" /></label>
              <div className="grid grid-cols-2 gap-3 phoneLandscape:col-span-2">
                <TerminalTimePicker label="시작" value={routineStart} fallbackValue="20:00" onChange={setRoutineStart} />
                <TerminalTimePicker label="종료" value={routineEnd} fallbackValue="20:30" onChange={setRoutineEnd} allowEmpty align="right" />
              </div>
              <WeekdaySelector selected={routineDays} onChange={setRoutineDays} />
              <label className="block text-sm font-bold">분류<select value={routineCategory} onChange={(event) => setRoutineCategory(event.target.value as IdealRoutine["category"])} className="terminalField mt-2">{routineCategories.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
              <label className="block text-sm font-bold">우선순위<select value={routinePriority} onChange={(event) => setRoutinePriority(Number(event.target.value))} className="terminalField mt-2">{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
              <div className="grid grid-cols-2 gap-3 pt-2 phoneLandscape:col-span-2">
                <button type="button" className="outlineButton" onClick={() => setIsRoutineModalOpen(false)}>취소</button>
                <button type="submit" className="terminalButton">{editingRoutineId ? "수정 저장" : "루틴 추가"}</button>
              </div>
            </form>
          </section>
        </div>
      )}
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
