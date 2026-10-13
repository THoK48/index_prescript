"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { PageHeading } from "@/components/PageHeading";
import { useLocalState } from "@/lib/localState";
import type { FailureReason, Task, Ticket } from "@/lib/ticketMachine";
import { parseCalendarWidgetDate, parseCalendarWidgetQuery } from "@/lib/calendarWidget";

const categories: { value: Task["category"]; label: string; accent: string }[] = [
  { value: "work", label: "업무", accent: "border-[#5cd0ff] bg-[#0a2a3d]" },
  { value: "study", label: "학업", accent: "border-[#2fbffc] bg-[#072233]" },
  { value: "personal", label: "개인", accent: "border-[#3188b5] bg-[#071b29]" },
  { value: "health", label: "건강", accent: "border-[#78d9ff] bg-[#0b3044]" },
  { value: "other", label: "기타", accent: "border-[#567287] bg-[#0a141c]" },
];

const weekdayLabels = ["일", "월", "화", "수", "목", "금", "토"];

const failureReasonLabels: Record<FailureReason, string> = {
  time_shortage: "시간 부족",
  time_elapsed: "시간 경과 / 놓침",
  physical_condition: "피곤함 / 몸 상태",
  schedule_changed: "일정 변경",
  place_or_tools: "장소 / 도구 문제",
  too_difficult: "예상보다 어려움",
  other: "기타",
};

/** Pads one date component for stable local calendar keys. */
function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

/** Converts a Date into a local YYYY-MM-DD key without UTC date drift. */
function toLocalDateKey(value: Date): string {
  return `${value.getFullYear()}-${padDatePart(value.getMonth() + 1)}-${padDatePart(value.getDate())}`;
}

/** Creates the default evening deadline used when a calendar day is selected. */
function createDefaultDueAt(value: Date): string {
  return `${toLocalDateKey(value)}T20:00`;
}

/** Converts a stored timestamp into a value accepted by datetime-local inputs. */
function toDateTimeLocalValue(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${toLocalDateKey(date)}T${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}`;
}

/** Returns the 42 dates needed for a stable six-row month calendar. */
function createMonthGridDays(viewMonth: Date): Date[] {
  const firstDay = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
  const gridStart = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1 - firstDay.getDay());
  return Array.from({ length: 42 }, (_, index) => (
    new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index)
  ));
}

/** Formats the currently visible month for the calendar header. */
function formatMonthLabel(value: Date): string {
  return new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long" }).format(value);
}

/** Formats the selected date for the detail panel. */
function formatSelectedDate(value: Date): string {
  return new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", weekday: "long" }).format(value);
}

/** Formats the time portion of a task deadline. */
function formatTaskTime(value?: string): string {
  if (!value) return "시간 미정";
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

/** Formats one completed directive timestamp for the daily history dialog. */
function formatExecutionTime(value?: string): string {
  if (!value) return "시간 미상";
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

/** Finds presentation metadata for a saved task category. */
function getCategory(category: Task["category"]) {
  return categories.find((item) => item.value === category) ?? categories.at(-1)!;
}

/** Groups completed and failed directive results by their local calendar date. */
function createDailyExecutionCounts(tickets: Ticket[]): Map<string, { completed: number; failed: number }> {
  const counts = new Map<string, { completed: number; failed: number }>();
  for (const ticket of tickets) {
    if (!ticket.completedAt || (ticket.status !== "COMPLETED" && ticket.status !== "FAILED")) continue;
    const completedAt = new Date(ticket.completedAt);
    if (Number.isNaN(completedAt.getTime())) continue;
    const dateKey = toLocalDateKey(completedAt);
    const current = counts.get(dateKey) ?? { completed: 0, failed: 0 };
    if (ticket.status === "COMPLETED") current.completed += 1;
    if (ticket.status === "FAILED") current.failed += 1;
    counts.set(dateKey, current);
  }
  return counts;
}

/** Presents the calendar beside date details on landscape phones and keeps editor dialogs within the viewport. */
export default function TasksPage() {
  const { state, addTask, updateTask, toggleTask, removeTask } = useLocalState();
  const [viewMonth, setViewMonth] = useState(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState(() => createDefaultDueAt(new Date()));
  const [category, setCategory] = useState<Task["category"]>("personal");
  const [importance, setImportance] = useState<Task["importance"]>(3);
  const [estimatedMinutes, setEstimatedMinutes] = useState("");
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [taskError, setTaskError] = useState("");
  const [historyFilter, setHistoryFilter] = useState<"COMPLETED" | "FAILED" | null>(null);
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);

  useEffect(() => {
    const request = parseCalendarWidgetQuery(window.location.search);
    if (!request) return;
    const date = parseCalendarWidgetDate(request.dateKey);
    if (!date) return;
    setSelectedDate(date);
    setViewMonth(new Date(date.getFullYear(), date.getMonth(), 1));
    setDueAt(createDefaultDueAt(date));
    setIsTaskModalOpen(true);
    // Consume only widget parameters so refresh and ordinary state changes do not reopen the form.
    const url = new URL(window.location.href);
    for (const key of ["widgetDate", "widgetRequestId", "newTask"]) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const calendarDays = useMemo(() => createMonthGridDays(viewMonth), [viewMonth]);
  const tasksByDate = useMemo(() => {
    const groups = new Map<string, Task[]>();
    for (const task of state?.tasks ?? []) {
      if (!task.dueAt) continue;
      const dateKey = toLocalDateKey(new Date(task.dueAt));
      groups.set(dateKey, [...(groups.get(dateKey) ?? []), task]);
    }
    for (const tasks of groups.values()) {
      tasks.sort((left, right) => (left.dueAt ?? "").localeCompare(right.dueAt ?? ""));
    }
    return groups;
  }, [state?.tasks]);
  const dailyExecutionCounts = useMemo(
    () => createDailyExecutionCounts(state?.tickets ?? []),
    [state?.tickets],
  );

  const selectedDateKey = toLocalDateKey(selectedDate);
  const selectedTasks = tasksByDate.get(selectedDateKey) ?? [];
  const undatedTasks = state?.tasks.filter((task) => !task.dueAt) ?? [];
  const todayKey = toLocalDateKey(new Date());
  const selectedHistoryEntries = (state?.tickets ?? [])
    .filter((ticket) => ticket.completedAt
      && toLocalDateKey(new Date(ticket.completedAt)) === selectedDateKey
      && (historyFilter === null || ticket.status === historyFilter))
    .sort((left, right) => (right.completedAt ?? "").localeCompare(left.completedAt ?? ""));
  const selectedExecutionCounts = dailyExecutionCounts.get(selectedDateKey) ?? { completed: 0, failed: 0 };

  /** Selects a day and prepares the input form for that calendar date. */
  function selectDate(date: Date) {
    setSelectedDate(date);
    setDueAt(createDefaultDueAt(date));
    if (date.getMonth() !== viewMonth.getMonth() || date.getFullYear() !== viewMonth.getFullYear()) {
      setViewMonth(new Date(date.getFullYear(), date.getMonth(), 1));
    }
  }

  /** Selects a calendar day and opens its new-task dialog. */
  function openTaskModal(date: Date) {
    selectDate(date);
    setEditingTaskId(null);
    setTitle("");
    setEstimatedMinutes("");
    setCategory("personal");
    setImportance(3);
    setTaskError("");
    setIsTaskModalOpen(true);
  }

  /** Opens the shared task dialog with one existing task loaded for editing. */
  function openTaskEditor(task: Task) {
    const taskDate = task.dueAt ? new Date(task.dueAt) : selectedDate;
    if (!Number.isNaN(taskDate.getTime())) selectDate(taskDate);
    setEditingTaskId(task.id);
    setTitle(task.title);
    setDueAt(toDateTimeLocalValue(task.dueAt));
    setEstimatedMinutes(task.estimatedMinutes?.toString() ?? "");
    setCategory(task.category);
    setImportance(task.importance);
    setTaskError("");
    setIsTaskModalOpen(true);
  }

  /** Opens one date's completed or failed directive history. */
  function openExecutionHistory(date: Date, filter: "COMPLETED" | "FAILED") {
    selectDate(date);
    setHistoryFilter(filter);
    setIsHistoryModalOpen(true);
  }

  /** Moves the monthly calendar while preserving a valid selected day. */
  function changeMonth(offset: number) {
    const nextMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + offset, 1);
    setViewMonth(nextMonth);
    setSelectedDate(nextMonth);
    setDueAt(createDefaultDueAt(nextMonth));
  }

  /** Returns the calendar to today and prepares today's task input. */
  function selectToday() {
    const today = new Date();
    setViewMonth(new Date(today.getFullYear(), today.getMonth(), 1));
    setSelectedDate(today);
    setDueAt(createDefaultDueAt(today));
  }

  /** Saves one task against the selected calendar date. */
  async function handleAddTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim()) return;
    setTaskError("");
    try {
      const existingTask = editingTaskId ? state?.tasks.find((task) => task.id === editingTaskId) : undefined;
      const draft = {
        title: title.trim(),
        dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
        estimatedMinutes: estimatedMinutes ? Number(estimatedMinutes) : undefined,
        importance,
        category,
        status: existingTask?.status ?? "TODO",
        completedMinutes: existingTask?.completedMinutes ?? 0,
      } satisfies Omit<Task, "id">;
      const error = editingTaskId
        ? await updateTask(editingTaskId, draft)
        : await addTask(draft);
      if (error) { setTaskError(error); return; }
      setTitle("");
      setEstimatedMinutes("");
      setIsTaskModalOpen(false);
      setMessage(editingTaskId ? "할 일을 수정했습니다." : `${formatSelectedDate(selectedDate)}에 할 일을 저장했습니다.`);
      setEditingTaskId(null);
    } catch {
      setTaskError("할 일을 저장하지 못했습니다.");
    }
  }

  if (!state) return <p role="status">데이터를 불러오는 중…</p>;

  return (
    <div className="w-full">
      <PageHeading code="TASK CALENDAR" title="할 일 달력" description="날짜를 선택해 해야 할 일을 확인하고, 현재 계획에 바로 추가합니다." />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start phoneLandscape:grid-cols-[minmax(0,1fr)_14rem] phoneLandscape:items-start phoneLandscape:gap-4">
        <section aria-label="월간 할 일 달력" className="min-w-0 border border-[#165b80] bg-[#02080d]">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#165b80] px-3 py-3 sm:px-5">
            <div className="flex items-center gap-2">
              <button type="button" aria-label="이전 달" className="h-10 w-10 border border-[#165b80] text-lg text-[#2fbffc] hover:border-[#2fbffc] hover:bg-[#072233]" onClick={() => changeMonth(-1)}>‹</button>
              <button type="button" aria-label="다음 달" className="h-10 w-10 border border-[#165b80] text-lg text-[#2fbffc] hover:border-[#2fbffc] hover:bg-[#072233]" onClick={() => changeMonth(1)}>›</button>
              <h2 className="ml-1 text-lg font-bold text-[#5cd0ff] sm:text-xl">{formatMonthLabel(viewMonth)}</h2>
            </div>
            <button type="button" className="min-h-10 border border-[#165b80] px-4 text-xs font-bold tracking-[.12em] text-[#2fbffc] hover:border-[#2fbffc] hover:bg-[#072233]" onClick={selectToday}>오늘</button>
          </header>

          <div className="grid grid-cols-7 border-b border-[#165b80] bg-[#050e18]">
            {weekdayLabels.map((label, index) => (
              <div key={label} className={`py-2 text-center text-[11px] font-bold tracking-[.12em] ${index === 0 ? "text-[#567287]" : "text-[#1c7ba6]"}`}>{label}</div>
            ))}
          </div>

          <div className="grid grid-cols-7">
            {calendarDays.map((date) => {
              const dateKey = toLocalDateKey(date);
              const dayTasks = tasksByDate.get(dateKey) ?? [];
              const executionCounts = dailyExecutionCounts.get(dateKey) ?? { completed: 0, failed: 0 };
              const isCurrentMonth = date.getMonth() === viewMonth.getMonth();
              const isSelected = dateKey === selectedDateKey;
              const isToday = dateKey === todayKey;
              return (
                <div
                  key={dateKey}
                  className={`relative h-20 min-w-0 overflow-hidden border-b border-r border-[#0d3043] p-1 text-left align-top transition-colors sm:h-28 sm:p-2 phoneLandscape:h-20 phoneLandscape:p-1 ${isCurrentMonth ? "bg-black" : "bg-[#020508] opacity-45"} ${isSelected ? "shadow-[inset_0_0_0_2px_#2fbffc]" : ""}`}
                >
                  <button
                    type="button"
                    aria-label={`${date.getMonth() + 1}월 ${date.getDate()}일, 할 일 ${dayTasks.length}개`}
                    aria-pressed={isSelected}
                    onClick={() => selectDate(date)}
                    onDoubleClick={() => openTaskModal(date)}
                    title="두 번 클릭하여 할 일 추가"
                    className="absolute inset-0 z-0 hover:bg-[#07131d]"
                  />
                  <span className={`pointer-events-none absolute left-1 top-1 z-10 flex h-6 w-6 items-center justify-center text-[11px] sm:left-2 sm:top-2 phoneLandscape:left-1 phoneLandscape:top-1 ${isToday ? "bg-[#2fbffc] font-bold text-black shadow-[0_0_8px_#2fbffc77]" : "text-[#5cd0ff]"}`}>{date.getDate()}</span>
                  <span className="pointer-events-none absolute inset-x-1 top-7 z-10 block overflow-hidden sm:inset-x-2 sm:top-9 phoneLandscape:inset-x-1 phoneLandscape:top-7">
                    {dayTasks.slice(0, 3).map((task) => (
                      <span key={task.id} className={`block h-2 truncate border-l px-1 py-0 text-[7px] leading-2 text-[#8edfff] ${getCategory(task.category).accent} ${task.status === "DONE" ? "opacity-45 line-through" : ""}`}>{task.title}</span>
                    ))}
                  </span>
                  {dayTasks.length > 3 && <span className="pointer-events-none absolute bottom-4 left-1 z-10 h-2 px-1 text-[7px] leading-2 text-[#1c7ba6] sm:bottom-5 sm:left-2 phoneLandscape:bottom-4 phoneLandscape:left-1">+{dayTasks.length - 3}</span>}
                  <span className="absolute inset-x-1 bottom-1 z-20 flex items-center justify-between gap-1 font-mono text-[8px] tabular-nums sm:inset-x-2 sm:text-[9px] phoneLandscape:inset-x-1 phoneLandscape:text-[8px] phoneLandscape:leading-3">
                    <button type="button" aria-label={`${date.getMonth() + 1}월 ${date.getDate()}일 수행 ${executionCounts.completed}회 보기`} className="whitespace-nowrap text-[#49d68c] hover:text-[#9affc8]" onClick={() => openExecutionHistory(date, "COMPLETED")}>{executionCounts.completed}</button>
                    <button type="button" aria-label={`${date.getMonth() + 1}월 ${date.getDate()}일 실패 ${executionCounts.failed}회 보기`} className="whitespace-nowrap text-[#ff5b6e] hover:text-[#ff9fab]" onClick={() => openExecutionHistory(date, "FAILED")}>{executionCounts.failed}</button>
                  </span>
                </div>
              );
            })}
          </div>

          {undatedTasks.length > 0 && (
            <div className="border-t border-[#165b80] px-4 py-4 sm:px-5">
              <p className="mb-3 text-xs font-bold tracking-[.14em] text-[#1c7ba6]">날짜 미정 · {undatedTasks.length}</p>
              <div className="flex flex-wrap gap-2">
                {undatedTasks.map((task) => (
                  <button type="button" key={task.id} onClick={() => openTaskEditor(task)} className={`border-l-2 px-2 py-1 text-xs text-[#8edfff] hover:border-[#2fbffc] ${getCategory(task.category).accent} ${task.status === "DONE" ? "opacity-45 line-through" : ""}`}>{task.title}</button>
                ))}
              </div>
            </div>
          )}
        </section>

        <aside className="min-w-0 space-y-5">
          <section aria-label="선택한 날짜의 할 일" className="border border-[#165b80] bg-[#050e18]">
            <div className="flex items-center justify-between gap-3 border-b border-[#165b80] px-5 py-4 phoneLandscape:px-3 phoneLandscape:py-3">
              <div className="min-w-0">
                <p className="text-[10px] tracking-[.18em] text-[#1c7ba6]">SELECTED DATE</p>
                <h2 className="mt-1 text-lg font-bold text-[#5cd0ff] phoneLandscape:text-sm">{formatSelectedDate(selectedDate)}</h2>
              </div>
              <button type="button" className="min-h-9 border border-[#2fbffc] px-3 text-xs font-bold text-[#5cd0ff] hover:bg-[#072233]" onClick={() => openTaskModal(selectedDate)}>+ 추가</button>
            </div>
            {selectedTasks.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-[#567287]">이 날짜에 등록된 할 일이 없습니다.</p>
            ) : (
              <ul className="max-h-72 divide-y divide-[#072233] overflow-y-auto phoneLandscape:max-h-40">
                {selectedTasks.map((task) => (
                  <li key={task.id} className="flex items-start gap-3 px-4 py-4 phoneLandscape:gap-2 phoneLandscape:px-3 phoneLandscape:py-3">
                    <input aria-label={`${task.title} 완료 여부`} type="checkbox" checked={task.status === "DONE"} onChange={() => void toggleTask(task.id)} className="mt-1 h-5 w-5 shrink-0 accent-[#2fbffc]" />
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => openTaskEditor(task)} aria-label={`${task.title} 수정`}>
                      <p className={`break-words text-sm font-semibold ${task.status === "DONE" ? "text-[#567287] line-through" : "text-[#5cd0ff]"}`}>{task.title}</p>
                      <p className="mt-1 text-[11px] text-[#1c7ba6]">{formatTaskTime(task.dueAt)} · {getCategory(task.category).label} · 중요도 {task.importance}</p>
                    </button>
                    <button type="button" aria-label={`${task.title} 삭제`} className="min-h-8 border border-[#165b80] px-2 text-[10px] text-[#1c7ba6] hover:border-[#2fbffc] hover:text-[#5cd0ff]" onClick={() => void removeTask(task.id)}>삭제</button>
                  </li>
                ))}
              </ul>
            )}
          </section>

        </aside>
      </div>

      {message && <p role="status" className="mt-5 text-sm text-[#5cd0ff]">{message}</p>}

      {isTaskModalOpen && (
        <div data-pin-terminal-navigation="true" className="terminalDialogOverlay fixed inset-0 z-30 flex items-end justify-center bg-black/80 sm:items-center phoneLandscape:items-start" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsTaskModalOpen(false); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="taskDialogTitle" className="terminalDialogPanel w-full max-w-lg border border-[#2fbffc] bg-[#071320] p-5 text-[#5cd0ff] shadow-[0_0_32px_#2fbffc44] sm:p-6 phoneLandscape:max-w-2xl phoneLandscape:p-4">
            <div className="mb-5 flex items-start justify-between gap-4 border-b border-[#165b80] pb-4">
              <div>
                <p className="text-[10px] tracking-[.18em] text-[#1c7ba6]">{editingTaskId ? "EDIT TASK" : "NEW TASK"} / {selectedDate.getMonth() + 1}.{selectedDate.getDate()}</p>
                <h2 id="taskDialogTitle" className="mt-1 text-xl font-bold">{editingTaskId ? "할 일 수정" : "새 할 일"}</h2>
              </div>
              <button type="button" aria-label="할 일 설정 창 닫기" className="h-9 w-9 border border-[#165b80] text-lg text-[#2fbffc] hover:border-[#2fbffc] hover:bg-[#072233]" onClick={() => setIsTaskModalOpen(false)}>×</button>
            </div>
            <form onSubmit={handleAddTask} className="space-y-4 phoneLandscape:grid phoneLandscape:grid-cols-2 phoneLandscape:gap-3 phoneLandscape:space-y-0">
              {taskError && <p role="alert" className="border border-[#2fbffc] bg-[#02080d] px-3 py-3 text-sm font-bold text-[#8edfff] shadow-[inset_3px_0_0_#2fbffc] phoneLandscape:col-span-2">ERROR / {taskError}</p>}
              <label className="block text-sm font-bold">할 일<input autoFocus required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="예: 보고서 초안 작성" className="terminalField mt-2" /></label>
              <label className="block text-sm font-bold">마감일<input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} className="terminalField mt-2" /></label>
              <label className="block text-sm font-bold">예상 소요시간 (분)<input type="number" min="5" max="1440" step="5" value={estimatedMinutes} onChange={(event) => setEstimatedMinutes(event.target.value)} placeholder="예: 120" className="terminalField mt-2" /></label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm font-bold">분류<select value={category} onChange={(event) => setCategory(event.target.value as Task["category"])} className="terminalField mt-2">{categories.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
                <label className="block text-sm font-bold">중요도<select value={importance} onChange={(event) => setImportance(Number(event.target.value) as Task["importance"])} className="terminalField mt-2">{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
              </div>
              <div className="grid grid-cols-2 gap-3 pt-2 phoneLandscape:col-span-2">
                <button type="button" className="outlineButton" onClick={() => setIsTaskModalOpen(false)}>취소</button>
                <button type="submit" className="terminalButton">{editingTaskId ? "수정 저장" : "할 일 추가"}</button>
              </div>
            </form>
          </section>
        </div>
      )}

      {isHistoryModalOpen && (
        <div data-pin-terminal-navigation="true" className="terminalDialogOverlay fixed inset-0 z-30 flex items-end justify-center bg-black/80 sm:items-center phoneLandscape:items-start" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsHistoryModalOpen(false); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="executionHistoryTitle" className="terminalDialogPanel w-full max-w-lg border border-[#2fbffc] bg-[#071320] p-5 text-[#5cd0ff] shadow-[0_0_32px_#2fbffc44] sm:p-6 phoneLandscape:max-w-2xl phoneLandscape:p-4">
            <div className="mb-4 flex items-start justify-between gap-4 border-b border-[#165b80] pb-4">
              <div>
                <p className="text-[10px] tracking-[.18em] text-[#1c7ba6]">EXECUTION LOG / {selectedDateKey}</p>
                <h2 id="executionHistoryTitle" className="mt-1 text-xl font-bold">{formatSelectedDate(selectedDate)} 수행 기록</h2>
              </div>
              <button type="button" aria-label="수행 기록 창 닫기" className="h-9 w-9 border border-[#165b80] text-lg text-[#2fbffc] hover:border-[#2fbffc] hover:bg-[#072233]" onClick={() => setIsHistoryModalOpen(false)}>×</button>
            </div>
            <div className="mb-4 grid grid-cols-2 gap-2">
              <button type="button" className={`min-h-10 border text-xs font-bold ${historyFilter === "COMPLETED" ? "border-[#49d68c] bg-[#0b2c21] text-[#8effbd]" : "border-[#165b80] text-[#31536a]"}`} onClick={() => setHistoryFilter("COMPLETED")}>수행 {selectedExecutionCounts.completed}</button>
              <button type="button" className={`min-h-10 border text-xs font-bold ${historyFilter === "FAILED" ? "border-[#ff5b6e] bg-[#301015] text-[#ff9fab]" : "border-[#165b80] text-[#31536a]"}`} onClick={() => setHistoryFilter("FAILED")}>실패 {selectedExecutionCounts.failed}</button>
            </div>
            {selectedHistoryEntries.length === 0 ? (
              <p className="border border-[#0d3043] px-4 py-8 text-center text-sm text-[#567287]">해당 기록이 없습니다.</p>
            ) : (
              <ol className="divide-y divide-[#0d3043] border border-[#165b80]">
                {selectedHistoryEntries.map((entry) => (
                  <li key={entry.id} className="px-4 py-4">
                    <div className="flex items-center justify-between gap-3 text-[10px] tracking-[.12em]">
                      <span className={entry.status === "COMPLETED" ? "text-[#49d68c]" : "text-[#ff5b6e]"}>{entry.status === "COMPLETED" ? "수행 완료" : "수행 실패"}</span>
                      <time className="text-[#31536a]">{formatExecutionTime(entry.completedAt)}</time>
                    </div>
                    <p className="mt-2 text-sm font-bold text-[#8edfff]">{entry.action}</p>
                    <p className="mt-2 text-[11px] text-[#31536a]">예상 {entry.expectedMinutes}분 · {entry.sourceType}{entry.failureReason ? ` · ${failureReasonLabels[entry.failureReason]}` : ""}</p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
