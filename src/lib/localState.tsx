"use client";

import { createContext, useContext, useEffect, useState } from "react";
import {
  completeTicket,
  createInitialState,
  failTicket,
  getActiveTicket,
  issueTicket,
  type AppState,
  type FailureReason,
  type InvalidDirectiveReason,
  type LocalScheduleItem,
  type IdealRoutine,
  type Settings,
  type Task,
  type TransitionResult,
} from "./ticketMachine";
import { createIdealRoutine, createLocalScheduleItem } from "./calendar";
import { planNextTicketWithDecision } from "./planner";
import {
  createStateBackup,
  currentStorageKey,
  migrateV1State,
  parseStateBackup,
  parseV2State,
  previousStorageKey,
} from "./stateMigration";
import { resolveAndReissueTicket } from "./ticketLifecycle";
import { syncNativeExperience } from "./nativeBridge";

const lockKey = "ticketPlannerState";

interface LocalStateContextValue {
  state: AppState | null;
  issue: () => Promise<boolean>;
  complete: (id: string) => Promise<boolean>;
  fail: (id: string, reason: FailureReason) => Promise<boolean>;
  completeAndReissue: (id: string) => Promise<boolean>;
  failAndReissue: (id: string, reason: FailureReason) => Promise<boolean>;
  /** Records Planner-quality feedback and issues the next directive in one state transition. */
  invalidateAndReissue: (id: string, reason: InvalidDirectiveReason) => Promise<boolean>;
  addTask: (task: Omit<Task, "id">) => Promise<string | null>;
  /** Updates one saved task after validating same-time conflicts. */
  updateTask: (id: string, task: Omit<Task, "id">) => Promise<string | null>;
  toggleTask: (id: string) => Promise<void>;
  removeTask: (id: string) => Promise<void>;
  addLocalScheduleItem: (item: Omit<LocalScheduleItem, "id">) => Promise<string | null>;
  removeLocalScheduleItem: (id: string) => Promise<void>;
  addIdealRoutine: (routine: Omit<IdealRoutine, "id">) => Promise<string | null>;
  /** Updates one saved routine after validating overlapping weekdays and start times. */
  updateIdealRoutine: (id: string, routine: Omit<IdealRoutine, "id">) => Promise<string | null>;
  toggleIdealRoutine: (id: string) => Promise<void>;
  removeIdealRoutine: (id: string) => Promise<void>;
  updateSettings: (settings: Settings) => Promise<void>;
  /** Serializes the latest persisted application state for portable backup. */
  exportBackup: () => string;
  /** Validates and atomically replaces local state from a portable backup. */
  importBackup: (payload: string) => Promise<string | null>;
}

const LocalStateContext = createContext<LocalStateContextValue | null>(null);

/** Creates a stable identity for detecting the same schedule saved more than once. */
function createScheduleIdentity(item: LocalScheduleItem): string {
  return JSON.stringify([
    item.title.trim(),
    item.startAt,
    item.endAt,
    item.type,
    item.recurrence?.frequency ?? "NONE",
    [...(item.recurrence?.daysOfWeek ?? [])].sort((left, right) => left - right),
  ]);
}

/** Creates a stable identity for detecting the same routine saved more than once. */
function createRoutineIdentity(item: IdealRoutine): string {
  return JSON.stringify([
    item.title.trim(),
    item.startTime,
    item.endTime ?? "",
    [...item.daysOfWeek].sort((left, right) => left - right),
    item.category,
    item.priority,
  ]);
}

/** Reports whether an existing task occupies the same explicitly selected deadline. */
function hasTaskTimeConflict(saved: Task, incoming: Omit<Task, "id">): boolean {
  return Boolean(incoming.dueAt) && saved.dueAt === incoming.dueAt;
}

/** Reports whether two routines apply to at least one of the same weekdays. */
function hasSharedRoutineDay(leftDays: number[], rightDays: number[]): boolean {
  return leftDays.some((day) => rightDays.includes(day));
}

/** Removes already-saved duplicate schedules while preserving the earliest record. */
function deduplicateSchedules(state: AppState): AppState {
  const identities = new Set<string>();
  const localScheduleItems = state.localScheduleItems.filter((item) => {
    const identity = createScheduleIdentity(item);
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
  return localScheduleItems.length === state.localScheduleItems.length
    ? state
    : { ...state, localScheduleItems };
}

/** Removes already-saved duplicate routines while preserving the earliest record. */
function deduplicateRoutines(state: AppState): AppState {
  const identities = new Set<string>();
  const idealRoutines = state.idealRoutines.filter((item) => {
    const identity = createRoutineIdentity(item);
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
  return idealRoutines.length === state.idealRoutines.length
    ? state
    : { ...state, idealRoutines };
}

/** Reads v0.2 data or migrates v0.1 data before allowing any state write. */
function readState(): AppState {
  const saved = window.localStorage.getItem(currentStorageKey);
  if (saved !== null) {
    const parsed = parseV2State(JSON.parse(saved) as unknown);
    if (!parsed) throw new Error("저장된 지령 데이터를 읽을 수 없습니다.");
    const deduplicated = deduplicateRoutines(deduplicateSchedules(parsed));
    if (deduplicated !== parsed) window.localStorage.setItem(currentStorageKey, JSON.stringify(deduplicated));
    return deduplicated;
  }

  const previous = window.localStorage.getItem(previousStorageKey);
  if (previous !== null) {
    const migrated = migrateV1State(JSON.parse(previous) as unknown);
    if (!migrated) throw new Error("이전 지령 데이터를 변환할 수 없습니다.");
    const deduplicated = deduplicateRoutines(deduplicateSchedules(migrated));
    window.localStorage.setItem(currentStorageKey, JSON.stringify(deduplicated));
    return deduplicated;
  }
  return createInitialState();
}

/** Serializes local writes across tabs when the Web Locks API is available. */
async function withStateLock<T>(callback: () => T): Promise<T> {
  if (navigator.locks) return navigator.locks.request(lockKey, callback);
  return callback();
}

/** Shares persistent local-first state with every Ticket Planner route. */
export function LocalStateProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AppState | null>(null);
  const [storageError, setStorageError] = useState("");

  useEffect(() => {
    try {
      setState(readState());
    } catch {
      setStorageError("저장된 데이터를 읽지 못했습니다. 기존 데이터는 변경하지 않았습니다.");
    }
    /** Synchronizes the latest state after another tab writes it. */
    function syncState(event: StorageEvent) {
      if (event.key !== currentStorageKey) return;
      try {
        setState(readState());
        setStorageError("");
      } catch {
        setStorageError("저장된 데이터를 읽지 못했습니다. 기존 데이터는 변경하지 않았습니다.");
      }
    }
    window.addEventListener("storage", syncState);
    return () => window.removeEventListener("storage", syncState);
  }, []);

  useEffect(() => {
    if (state) void syncNativeExperience(state);
  }, [state]);

  /** Applies a state-machine transition to the latest saved state. */
  async function transition(operation: (current: AppState) => TransitionResult): Promise<boolean> {
    return withStateLock(() => {
      const result = operation(readState());
      if (result.kind === "conflict") {
        setState(result.state);
        return false;
      }
      window.localStorage.setItem(currentStorageKey, JSON.stringify(result.state));
      setState(result.state);
      return true;
    });
  }

  /** Persists a calendar, task, or settings edit against the latest state. */
  async function update(change: (current: AppState) => AppState): Promise<void> {
    await withStateLock(() => {
      const nextState = change(readState());
      window.localStorage.setItem(currentStorageKey, JSON.stringify(nextState));
      setState(nextState);
    });
  }

  const value: LocalStateContextValue = {
    state,
    issue: () => transition((current) => {
      // ACTIVE 지령이 있으면 다음 행동을 계산하기 전 상태 전이를 거부합니다.
      if (getActiveTicket(current)) return { kind: "conflict", state: current };
      const now = new Date();
      const plan = planNextTicketWithDecision({
        now,
        tasks: current.tasks,
        localSchedule: current.localScheduleItems,
        idealRoutines: current.idealRoutines,
        recentTickets: current.tickets,
        settings: current.settings,
      });
      return issueTicket(current, plan.candidate, now, crypto.randomUUID(), plan.decision);
    }),
    complete: (id) => transition((current) => completeTicket(current, id, new Date())),
    fail: (id, reason) => transition((current) => failTicket(current, id, reason, new Date())),
    completeAndReissue: (id) => transition((current) => {
      const now = new Date();
      return resolveAndReissueTicket(current, id, { kind: "complete" }, now, crypto.randomUUID());
    }),
    failAndReissue: (id, reason) => transition((current) => {
      const now = new Date();
      return resolveAndReissueTicket(current, id, { kind: "fail", reason }, now, crypto.randomUUID());
    }),
    /** Keeps invalid feedback separate from execution results and replans against the updated history. */
    invalidateAndReissue: (id, reason) => transition((current) => {
      const now = new Date();
      return resolveAndReissueTicket(current, id, { kind: "invalid", reason }, now, crypto.randomUUID());
    }),
    addTask: async (task) => {
      let conflictMessage: string | null = null;
      await update((current) => {
        const hasTimeConflict = current.tasks.some((saved) => hasTaskTimeConflict(saved, task));
        if (hasTimeConflict) {
          conflictMessage = "같은 날짜와 시간에 등록된 할 일이 이미 있습니다.";
          return current;
        }
        return { ...current, tasks: [...current.tasks, { ...task, id: crypto.randomUUID() }] };
      });
      return conflictMessage;
    },
    /** Updates one saved task while retaining its identity and accumulated progress. */
    updateTask: async (id, task) => {
      let conflictMessage: string | null = null;
      await update((current) => {
        if (!current.tasks.some((saved) => saved.id === id)) {
          conflictMessage = "수정할 할 일을 찾지 못했습니다.";
          return current;
        }
        const hasTimeConflict = current.tasks.some((saved) => saved.id !== id && hasTaskTimeConflict(saved, task));
        if (hasTimeConflict) {
          conflictMessage = "같은 날짜와 시간에 등록된 할 일이 이미 있습니다.";
          return current;
        }
        return {
          ...current,
          tasks: current.tasks.map((saved) => saved.id === id ? { ...task, id } : saved),
        };
      });
      return conflictMessage;
    },
    toggleTask: (id) => update((current) => ({
      ...current,
      tasks: current.tasks.map((task) => task.id === id ? { ...task, status: task.status === "DONE" ? "TODO" : "DONE" } : task),
    })),
    removeTask: (id) => update((current) => ({ ...current, tasks: current.tasks.filter((task) => task.id !== id) })),
    addLocalScheduleItem: async (item) => {
      const result = createLocalScheduleItem(item, crypto.randomUUID());
      if (result.kind === "invalid") return result.message;
      let isDuplicate = false;
      await update((current) => {
        const identity = createScheduleIdentity(result.value);
        isDuplicate = current.localScheduleItems.some((saved) => createScheduleIdentity(saved) === identity);
        return isDuplicate ? current : { ...current, localScheduleItems: [...current.localScheduleItems, result.value] };
      });
      return isDuplicate ? "동일한 일정이 이미 등록되어 있습니다." : null;
    },
    removeLocalScheduleItem: (id) => update((current) => ({ ...current, localScheduleItems: current.localScheduleItems.filter((item) => item.id !== id) })),
    addIdealRoutine: async (routine) => {
      const result = createIdealRoutine(routine, crypto.randomUUID());
      if (result.kind === "invalid") return result.message;
      let conflictMessage: string | null = null;
      await update((current) => {
        const hasTimeConflict = current.idealRoutines.some((saved) => (
          saved.startTime === result.value.startTime
          && hasSharedRoutineDay(saved.daysOfWeek, result.value.daysOfWeek)
        ));
        if (hasTimeConflict) {
          conflictMessage = "선택한 요일의 같은 시작 시간에 등록된 루틴이 이미 있습니다.";
          return current;
        }
        return { ...current, idealRoutines: [...current.idealRoutines, result.value] };
      });
      return conflictMessage;
    },
    /** Updates one saved routine while retaining its identity and enabled state. */
    updateIdealRoutine: async (id, routine) => {
      const result = createIdealRoutine(routine, id);
      if (result.kind === "invalid") return result.message;
      let conflictMessage: string | null = null;
      await update((current) => {
        if (!current.idealRoutines.some((saved) => saved.id === id)) {
          conflictMessage = "수정할 루틴을 찾지 못했습니다.";
          return current;
        }
        const hasTimeConflict = current.idealRoutines.some((saved) => (
          saved.id !== id
          && saved.startTime === result.value.startTime
          && hasSharedRoutineDay(saved.daysOfWeek, result.value.daysOfWeek)
        ));
        if (hasTimeConflict) {
          conflictMessage = "선택한 요일의 같은 시작 시간에 등록된 루틴이 이미 있습니다.";
          return current;
        }
        return {
          ...current,
          idealRoutines: current.idealRoutines.map((saved) => saved.id === id ? result.value : saved),
        };
      });
      return conflictMessage;
    },
    toggleIdealRoutine: (id) => update((current) => ({
      ...current,
      idealRoutines: current.idealRoutines.map((routine) => routine.id === id ? { ...routine, enabled: !routine.enabled } : routine),
    })),
    removeIdealRoutine: (id) => update((current) => ({ ...current, idealRoutines: current.idealRoutines.filter((routine) => routine.id !== id) })),
    updateSettings: (settings) => update((current) => ({ ...current, settings })),
    /** Serializes the latest persisted state into a portable, versioned backup. */
    exportBackup: () => JSON.stringify(createStateBackup(readState(), new Date()), null, 2),
    /** Replaces local state only after the supplied backup has been parsed and normalized. */
    importBackup: async (payload) => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(payload) as unknown;
      } catch {
        return "JSON 형식이 올바르지 않습니다.";
      }
      const imported = parseStateBackup(decoded);
      if (!imported) return "지령 단말기 백업 파일로 확인되지 않습니다.";
      await withStateLock(() => {
        window.localStorage.setItem(currentStorageKey, JSON.stringify(imported));
        setState(imported);
      });
      return null;
    },
  };

  if (storageError) return <div role="alert" className="mx-auto max-w-xl p-8 text-center text-white">{storageError}</div>;
  return <LocalStateContext.Provider value={value}>{children}</LocalStateContext.Provider>;
}

/** Returns ticket state and mutation actions for a client component. */
export function useLocalState(): LocalStateContextValue {
  const context = useContext(LocalStateContext);
  if (!context) throw new Error("LocalStateProvider is missing.");
  return context;
}
