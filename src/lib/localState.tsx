"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  completeTicket,
  continueTicket,
  createInitialState,
  failTicket,
  getActiveTicket,
  type AppState,
  type FailureReason,
  type InvalidDirectiveReason,
  type LocalScheduleItem,
  type IdealRoutine,
  type Settings,
  type Task,
  type TransitionResult,
} from "./ticketMachine";
import {
  createIdealRoutine,
  createLocalScheduleItem,
  getNextRoutineOccurrence,
  type RoutineOccurrence,
} from "./calendar";
import {
  createStateBackup,
  currentStorageKey,
  migrateV1State,
  parseStateBackup,
  parseV2State,
  previousStorageKey,
} from "./stateMigration";
import { planAndIssueTicket, replanForUserContext, resolveAndReissueTicket, saveUserContextState } from "./ticketLifecycle";
import { contextDirectiveIssuedEvent, getNextContextExpiry, resolveEffectiveContext, type UserContext } from "./userContext";
import {
  addRoutineNotificationActionListener,
  cancelRoutineStartNotification,
  findRoutineForNotification,
  sendRoutineStartNotification,
  syncNativeExperience,
} from "./nativeBridge";

const lockKey = "ticketPlannerState";

interface LocalStateContextValue {
  state: AppState | null;
  /** Stores context while preserving ACTIVE until explicit cancellation confirmation. */
  saveUserContext: (context: UserContext) => Promise<boolean>;
  /** Resolves a context conflict as cancellation, not FAILED or INVALID. */
  replanUserContext: (ticketId: string) => Promise<boolean>;
  issue: () => Promise<boolean>;
  complete: (id: string) => Promise<boolean>;
  /** Keeps the directive ACTIVE while extending only its expected-end confirmation. */
  continueActive: (id: string, extensionMinutes?: number) => Promise<boolean>;
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
  /** Restores a recently deleted task with its original source identity. */
  restoreTask: (task: Task) => Promise<string | null>;
  addLocalScheduleItem: (item: Omit<LocalScheduleItem, "id">) => Promise<string | null>;
  removeLocalScheduleItem: (id: string) => Promise<void>;
  addIdealRoutine: (routine: Omit<IdealRoutine, "id">) => Promise<string | null>;
  /** Updates one saved routine after validating overlapping weekdays and start times. */
  updateIdealRoutine: (id: string, routine: Omit<IdealRoutine, "id">) => Promise<string | null>;
  /** Atomically applies one confirmed routine-editor preview without touching ACTIVE state. */
  applyIdealRoutineBatch: (routines: IdealRoutine[]) => Promise<string | null>;
  toggleIdealRoutine: (id: string) => Promise<void>;
  removeIdealRoutine: (id: string) => Promise<void>;
  /** Restores a recently deleted routine with its original source identity. */
  restoreIdealRoutine: (routine: IdealRoutine) => Promise<string | null>;
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
    item.timingMode,
    item.executionConstraints,
    Boolean(item.locked),
    (item.steps ?? []).map((step) => [step.title.trim(), step.actionType, step.expectedMinutes, step.executionConstraints]),
    (item.dateOverrides ?? []).map((override) => [override.dateKey, override.startTime, override.endTime ?? "", override.startDayOffset ?? 0]),
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

/** Runs the deterministic Planner only when no ACTIVE directive exists, preserving the state-machine invariant. */
function planAndIssueCurrentState(current: AppState, now: Date, ticketId: string): TransitionResult {
  return planAndIssueTicket(current, now, ticketId);
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
  const previousActiveTicketId = useRef<string | null | undefined>(undefined);
  const hasSyncedContextOnEntry = useRef(false);

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
    if (!state) return;
    const activeTicketId = getActiveTicket(state)?.id ?? null;
    const issuedTicketId = previousActiveTicketId.current !== undefined
      && activeTicketId !== null
      && activeTicketId !== previousActiveTicketId.current
      ? activeTicketId
      : undefined;
    previousActiveTicketId.current = activeTicketId;
    void syncNativeExperience(state, { issuedTicketId });
  }, [state]);

  useEffect(() => {
    let isDisposed = false;
    let removeListener: (() => Promise<void>) | undefined;
    void addRoutineNotificationActionListener(async ({ routineId }) => {
      const current = readState();
      if (!findRoutineForNotification(current, routineId)) return;
      if (!getActiveTicket(current)) {
        const issued = await transition((latest) => planAndIssueCurrentState(latest, new Date(), crypto.randomUUID()));
        if (issued) {
          const latest = readState();
          const issuedTicketId = getActiveTicket(latest)?.id;
          await syncNativeExperience(latest, { issuedTicketId });
        }
      }
      window.location.href = "/";
    }).then((remove) => {
      if (isDisposed) void remove();
      else removeListener = remove;
    });
    return () => {
      isDisposed = true;
      if (removeListener) void removeListener();
    };
  }, []);

  useEffect(() => {
    if (!state) return;
    const occurrence = getNextRoutineOccurrence(state.idealRoutines, new Date());
    if (!occurrence) return;
    const boundaryDelay = Math.max(0, occurrence.startAt.getTime() - Date.now());
    const boundaryTimer = window.setTimeout(() => {
      if (document.visibilityState === "visible") void handleForegroundRoutineBoundary(occurrence);
    }, boundaryDelay);
    return () => window.clearTimeout(boundaryTimer);
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const expiry = getNextContextExpiry(state.userContext, new Date());
    /** Reconciles saved context on foreground return or expiration without replacing an existing ACTIVE. */
    async function refreshContext() {
      if (document.visibilityState !== "visible") return;
      try {
        await transitionWithContextSignal((current) => {
          const now = new Date();
          const effective = resolveEffectiveContext(current.userContext, now);
          const changed = JSON.stringify(effective) !== JSON.stringify(current.userContext);
          const next = changed ? { ...current, userContext: effective } : current;
          if (!getActiveTicket(next) && (changed || next.plannerDeferral)) return planAndIssueCurrentState(next, now, crypto.randomUUID());
          return { kind: "success", state: next };
        });
      } catch {
        setStorageError("현재 상태와 알림을 동기화하지 못했습니다. 앱을 다시 열어 주세요.");
      }
    }
    const timer = expiry ? window.setTimeout(() => void refreshContext(), Math.min(2_147_000_000, Math.max(0, new Date(expiry).getTime() - Date.now()))) : undefined;
    if (!hasSyncedContextOnEntry.current) {
      hasSyncedContextOnEntry.current = true;
      void refreshContext();
    }
    window.addEventListener("focus", refreshContext);
    window.addEventListener("pageshow", refreshContext);
    document.addEventListener("visibilitychange", refreshContext);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("focus", refreshContext);
      window.removeEventListener("pageshow", refreshContext);
      document.removeEventListener("visibilitychange", refreshContext);
    };
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

  /** Announces only an actually persisted context-driven ACTIVE, allowing the main screen to play its issue sound. */
  async function transitionWithContextSignal(operation: (current: AppState) => TransitionResult): Promise<boolean> {
    let issuedTicketId: string | undefined;
    const success = await transition((current) => {
      const result = operation(current);
      if (result.kind === "success") {
        const nextActive = getActiveTicket(result.state);
        if (nextActive && nextActive.id !== getActiveTicket(current)?.id) issuedTicketId = nextActive.id;
      }
      return result;
    });
    if (success && issuedTicketId) window.dispatchEvent(new CustomEvent(contextDirectiveIssuedEvent, { detail: { ticketId: issuedTicketId } }));
    return success;
  }

  /** Persists a calendar, task, or settings edit against the latest state. */
  async function update(change: (current: AppState) => AppState): Promise<void> {
    await withStateLock(() => {
      const nextState = change(readState());
      window.localStorage.setItem(currentStorageKey, JSON.stringify(nextState));
      setState(nextState);
    });
  }

  /** Replans at a visible routine boundary, or emits information when an ACTIVE directive must be retained. */
  async function handleForegroundRoutineBoundary(occurrence: RoutineOccurrence): Promise<void> {
    try {
      await cancelRoutineStartNotification(occurrence.routine.id, occurrence.startAt);
    } catch {
      console.warn("Routine notification cancellation failed before foreground planning.");
    }
    if (document.visibilityState !== "visible") {
      await sendRoutineStartNotification(occurrence);
      return;
    }
    const issued = await transition((current) => planAndIssueCurrentState(current, new Date(), crypto.randomUUID()));
    if (!issued || !getActiveTicket(readState())) await sendRoutineStartNotification(occurrence);
  }

  const value: LocalStateContextValue = {
    state,
    saveUserContext: (context) => transitionWithContextSignal((current) => saveUserContextState(current, context, new Date(), crypto.randomUUID())),
    replanUserContext: (ticketId) => transition((current) => replanForUserContext(current, ticketId, new Date(), crypto.randomUUID())),
    issue: () => transition((current) => planAndIssueCurrentState(current, new Date(), crypto.randomUUID())),
    complete: (id) => transition((current) => completeTicket(current, id, new Date())),
    continueActive: (id, extensionMinutes = 10) => transition((current) => (
      continueTicket(current, id, new Date(), extensionMinutes)
    )),
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
    /** Edits Task details without overwriting completion, progress, or the explicitly reopened work cycle. */
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
          tasks: current.tasks.map((saved) => saved.id === id ? {
            ...saved,
            ...task,
            id,
            status: saved.status,
            completedMinutes: saved.completedMinutes,
            completedAt: saved.completedAt,
            reopenedAt: saved.reopenedAt,
          } : saved),
        };
      });
      return conflictMessage;
    },
    /** Reopens an explicit new work cycle while keeping all earlier Ticket history intact. */
    toggleTask: (id) => update((current) => {
      const changedAt = new Date().toISOString();
      return {
        ...current,
        tasks: current.tasks.map((task) => task.id !== id ? task : task.status === "DONE"
          ? { ...task, status: "TODO", completedMinutes: 0, completedAt: undefined, reopenedAt: changedAt }
          : { ...task, status: "DONE", completedAt: changedAt }),
      };
    }),
    removeTask: (id) => update((current) => ({ ...current, tasks: current.tasks.filter((task) => task.id !== id) })),
    /** Restores one deleted Task unless a new item now occupies the same ID or explicit deadline. */
    restoreTask: async (task) => {
      let conflictMessage: string | null = null;
      await update((current) => {
        if (current.tasks.some((saved) => saved.id === task.id)) return current;
        if (current.tasks.some((saved) => hasTaskTimeConflict(saved, task))) {
          conflictMessage = "같은 날짜와 시간에 다른 할 일이 등록되어 복원하지 못했습니다.";
          return current;
        }
        return { ...current, tasks: [...current.tasks, task] };
      });
      return conflictMessage;
    },
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
    /** Validates and stores a complete routine list so chained time changes cannot be partially applied. */
    applyIdealRoutineBatch: async (routines) => {
      let errorMessage: string | null = null;
      await update((current) => {
        const currentIds = new Set(current.idealRoutines.map((routine) => routine.id));
        const incomingIds = new Set(routines.map((routine) => routine.id));
        if (routines.length !== current.idealRoutines.length || incomingIds.size !== routines.length ||
            [...currentIds].some((id) => !incomingIds.has(id))) {
          errorMessage = "루틴 목록이 변경되어 일괄 적용하지 못했습니다. 다시 미리보기 해주세요.";
          return current;
        }
        const validated: IdealRoutine[] = [];
        for (const routine of routines) {
          const { id, ...draft } = routine;
          const result = createIdealRoutine(draft, id);
          if (result.kind === "invalid") {
            errorMessage = result.message;
            return current;
          }
          validated.push(result.value);
        }
        return { ...current, idealRoutines: validated };
      });
      return errorMessage;
    },
    toggleIdealRoutine: (id) => update((current) => ({
      ...current,
      idealRoutines: current.idealRoutines.map((routine) => routine.id === id ? { ...routine, enabled: !routine.enabled } : routine),
    })),
    removeIdealRoutine: (id) => update((current) => ({ ...current, idealRoutines: current.idealRoutines.filter((routine) => routine.id !== id) })),
    /** Restores one deleted Routine unless a new routine now occupies its weekday and start time. */
    restoreIdealRoutine: async (routine) => {
      let conflictMessage: string | null = null;
      await update((current) => {
        if (current.idealRoutines.some((saved) => saved.id === routine.id)) return current;
        const hasTimeConflict = current.idealRoutines.some((saved) => (
          saved.startTime === routine.startTime
          && hasSharedRoutineDay(saved.daysOfWeek, routine.daysOfWeek)
        ));
        if (hasTimeConflict) {
          conflictMessage = "같은 요일과 시작 시간에 다른 루틴이 등록되어 복원하지 못했습니다.";
          return current;
        }
        return { ...current, idealRoutines: [...current.idealRoutines, routine] };
      });
      return conflictMessage;
    },
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
