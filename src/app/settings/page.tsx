"use client";

import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { Capacitor } from "@capacitor/core";
import { PageHeading } from "@/components/PageHeading";
import { ExecutionConstraintsEditor } from "@/components/ExecutionConstraintsEditor";
import { UserContextControl } from "@/components/UserContextControl";
import { describeUserContext } from "@/lib/userContext";
import { InvalidDirectiveHistory } from "@/components/invalidDirectiveHistory";
import { calendarWidgetBridge } from "@/lib/calendarWidgetBridge";
import { useLocalState } from "@/lib/localState";
import {
  getNotificationDiagnostics,
  openExactAlarmSettings,
  resynchronizeNativeNotifications,
  requestNotificationPermission,
  scheduleNotificationTest,
  type NotificationDiagnostics,
  type NotificationPermissionSnapshot,
} from "@/lib/nativeBridge";
import type {
  AppState,
  PlannerCandidateDisposition,
  PlannerDecisionRecord,
  Settings,
  SystemFallback,
} from "@/lib/ticketMachine";
import { createDefaultSystemFallbacks } from "@/lib/ticketMachine";
import { parseStateBackup } from "@/lib/stateMigration";

const plannerDispositionLabels: Record<PlannerCandidateDisposition, string> = {
  SELECTED: "선택",
  ELIGIBLE: "후보",
  EXCLUDED: "제외",
  SKIPPED: "우선순위 제외",
};

/** Formats a Planner evaluation timestamp in the device's local time. */
function formatPlannerDecisionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

/** Returns a muted terminal color for one Planner candidate disposition. */
function getDispositionColor(disposition: PlannerCandidateDisposition): string {
  if (disposition === "SELECTED") return "text-[#5cd0ff]";
  if (disposition === "ELIGIBLE") return "text-[#57cda1]";
  if (disposition === "EXCLUDED") return "text-[#e0717d]";
  return "text-[#567287]";
}

/** Creates a local calendar date suitable for a readable backup filename. */
function createBackupDateStamp(now: Date): string {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

/** Edits personal preferences with compact spacing when displayed alongside backup controls in landscape. */
function SettingsEditor({ initialSettings, save }: { initialSettings: Settings; save: (settings: Settings) => Promise<void> }) {
  const [settings, setSettings] = useState(initialSettings);
  const [message, setMessage] = useState("");

  /** Persists valid settings and reports the outcome. */
  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings.userName.trim()) {
      setMessage("사용자 이름을 입력해 주세요.");
      return;
    }
    try {
      await save({ ...settings, userName: settings.userName.trim() });
      setMessage("설정을 저장했습니다. 다음 지령부터 이름이 반영됩니다.");
    } catch {
      setMessage("설정을 저장하지 못했습니다.");
    }
  }

  return (
      <form onSubmit={handleSave} className="min-w-0 border border-[#165b80] bg-[#071320] p-6 text-[#5cd0ff] sm:p-8 phoneLandscape:p-4">
        <p className="mb-7 border-b border-[#165b80] pb-4 text-xs font-bold tracking-[.17em] phoneLandscape:mb-4 phoneLandscape:pb-3">PROFILE / 사용자 설정</p>
        <div className="grid gap-5 sm:grid-cols-2 phoneLandscape:gap-3">
          <label className="block text-sm font-bold sm:col-span-2">사용자 이름<input required maxLength={30} value={settings.userName} onChange={(event) => setSettings({ ...settings, userName: event.target.value })} className="terminalField mt-2" /></label>
          <label className="block text-sm font-bold">취침 시간<input required type="time" value={settings.preferredBedtime} onChange={(event) => setSettings({ ...settings, preferredBedtime: event.target.value })} className="terminalField mt-2" /></label>
          <label className="block text-sm font-bold">기상 시간<input required type="time" value={settings.preferredWakeTime} onChange={(event) => setSettings({ ...settings, preferredWakeTime: event.target.value })} className="terminalField mt-2" /></label>
          <label className="block text-sm font-bold sm:col-span-2">지령 문체<select value={settings.tone} onChange={(event) => setSettings({ ...settings, tone: event.target.value as Settings["tone"] })} className="terminalField mt-2"><option value="dry">건조한 문장</option><option value="formal">격식 있는 문장</option></select></label>
        </div>
        <button type="submit" className="mt-7 min-h-12 w-full bg-[#2fbffc] px-4 font-bold text-black hover:bg-[#5cd0ff] hover:shadow-[0_0_12px_#2fbffc66] sm:w-auto sm:min-w-40 phoneLandscape:mt-4 phoneLandscape:w-full">설정 저장</button>
        {message && <p role="status" className="mt-4 text-sm">{message}</p>}
      </form>
  );
}

/** Lets Android request the real calendar AppWidget provider from a supported launcher. */
function CalendarWidgetPanel() {
  const [isAndroid, setIsAndroid] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setIsAndroid(Capacitor.getPlatform() === "android");
  }, []);

  if (!isAndroid) return null;

  /** Opens the launcher-owned widget placement flow and reports unsupported launchers. */
  async function handlePin() {
    try {
      const result = await calendarWidgetBridge.pin();
      setMessage(result.requested
        ? "홈 화면에서 달력 위젯 위치를 확정해 주세요."
        : result.supported
          ? "위젯 추가 요청이 취소되었거나 시작되지 않았습니다."
          : "이 런처는 앱 내부 위젯 추가를 지원하지 않습니다. 홈 화면의 위젯 목록에서 ‘할 일 등록 달력’을 선택해 주세요.");
    } catch {
      setMessage("달력 위젯 추가 요청을 시작하지 못했습니다.");
    }
  }

  return (
    <section className="mt-6 border border-[#165b80] bg-[#050e18] p-5 text-[#5cd0ff] sm:p-6 phoneLandscape:p-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs font-bold tracking-[.17em]">ANDROID / 캘린더 위젯</p>
          <p className="mt-2 text-xs leading-5 text-[#567287]">바로가기가 아닌 월간 달력 위젯을 홈 화면에 추가합니다.</p>
        </div>
        <button type="button" className="outlineButton min-h-10 px-4 text-xs" onClick={() => void handlePin()}>달력 위젯 추가</button>
      </div>
      {message && <p role="status" className="mt-3 text-xs text-[#1c7ba6]">{message}</p>}
    </section>
  );
}

/** Formats a native notification reservation in the device's local time. */
function formatNotificationReservation(value?: string): string {
  if (!value) return "예약 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "확인 불가";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

/** Shows native alert access, live reservations, testing, and explicit resynchronization controls. */
function NotificationPermissionPanel({ state }: { state: AppState }) {
  const [snapshot, setSnapshot] = useState<NotificationPermissionSnapshot | null>(null);
  const [diagnostics, setDiagnostics] = useState<NotificationDiagnostics | null>(null);
  const [message, setMessage] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  /** Refreshes native access without opening a system permission prompt. */
  async function refreshStatus() {
    try {
      const nextDiagnostics = await getNotificationDiagnostics();
      setSnapshot(nextDiagnostics.permission);
      setDiagnostics(nextDiagnostics);
      setMessage("");
    } catch {
      setMessage("알림 권한 상태를 확인하지 못했습니다.");
    }
  }

  useEffect(() => {
    void refreshStatus();
  }, []);

  if (!snapshot?.isNative) return null;
  const displayGranted = snapshot.display === "granted";
  const exactAlarmGranted = snapshot.exactAlarm === "granted";

  /** Requests the operating system's display permission and updates the visible status. */
  async function handleDisplayPermission() {
    try {
      setSnapshot(await requestNotificationPermission());
      await refreshStatus();
      setMessage("알림 권한 상태를 갱신했습니다.");
    } catch {
      setMessage("알림 권한 요청을 완료하지 못했습니다.");
    }
  }

  /** Opens Android's Alarms & reminders screen instead of silently claiming exact access. */
  async function handleExactAlarmSettings() {
    try {
      setSnapshot(await openExactAlarmSettings());
      await refreshStatus();
      setMessage("정확한 알림 권한 상태를 갱신했습니다.");
    } catch {
      setMessage("정확한 알림 설정을 열지 못했습니다.");
    }
  }

  /** Schedules a visible custom-sound alert ten seconds later for on-device verification. */
  async function handleNotificationTest() {
    setIsBusy(true);
    try {
      const nextDiagnostics = await scheduleNotificationTest();
      setSnapshot(nextDiagnostics.permission);
      setDiagnostics(nextDiagnostics);
      setMessage("10초 후 시험 알림을 예약했습니다. 앱을 닫거나 다른 화면에서 확인해 주세요.");
    } catch {
      setMessage("시험 알림을 예약하지 못했습니다. 알림 권한을 확인해 주세요.");
    } finally {
      setIsBusy(false);
    }
  }

  /** Rebuilds routine and ACTIVE reservations from the latest local state. */
  async function handleNotificationResync() {
    setIsBusy(true);
    try {
      await resynchronizeNativeNotifications(state);
      await refreshStatus();
      setMessage("현재 데이터 기준으로 알림 예약을 다시 구성했습니다.");
    } catch {
      setMessage("알림 예약을 다시 구성하지 못했습니다.");
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <section className="mt-6 border border-[#165b80] bg-[#050e18] p-5 text-[#5cd0ff] sm:p-6 phoneLandscape:p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold tracking-[.17em]">NATIVE / 알림 권한</p>
          <p className="mt-2 text-xs leading-5 text-[#567287]">지령 발급, 루틴 시작, 예상 수행시간 종료 알림에 사용합니다.</p>
        </div>
        <button type="button" className="outlineButton min-h-9 px-3 text-xs" onClick={() => void refreshStatus()}>상태 새로고침</button>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="border border-[#0d3850] bg-[#071320] p-4">
          <p className="text-[10px] tracking-[.14em] text-[#31536a]">NOTIFICATION DISPLAY</p>
          <p className={`mt-2 text-sm font-bold ${displayGranted ? "text-[#57cda1]" : "text-[#e0717d]"}`}>{displayGranted ? "허용됨" : "허용 필요"}</p>
          {!displayGranted && <button type="button" className="outlineButton mt-3 min-h-9 px-3 text-xs" onClick={() => void handleDisplayPermission()}>알림 권한 요청</button>}
        </div>
        {snapshot.platform === "android" && (
          <div className="border border-[#0d3850] bg-[#071320] p-4">
            <p className="text-[10px] tracking-[.14em] text-[#31536a]">EXACT ALARM</p>
            <p className={`mt-2 text-sm font-bold ${exactAlarmGranted ? "text-[#57cda1]" : "text-[#e0717d]"}`}>{exactAlarmGranted ? "정확한 시각 허용됨" : "미허용 · 부정확한 시각으로 대체"}</p>
            {!exactAlarmGranted && <button type="button" className="outlineButton mt-3 min-h-9 px-3 text-xs" onClick={() => void handleExactAlarmSettings()}>정확한 알림 설정</button>}
          </div>
        )}
        <div className="border border-[#0d3850] bg-[#071320] p-4">
          <p className="text-[10px] tracking-[.14em] text-[#31536a]">PENDING RESERVATIONS</p>
          <p className="mt-2 text-sm font-bold text-[#5cd0ff]">{diagnostics?.pendingCount ?? 0}개</p>
          <p className="mt-1 text-[11px] text-[#567287]">다음 알림 {formatNotificationReservation(diagnostics?.nextNotificationAt)}</p>
        </div>
        <div className="border border-[#0d3850] bg-[#071320] p-4">
          <p className="text-[10px] tracking-[.14em] text-[#31536a]">DIAGNOSTIC TOOLS</p>
          <div className="mt-3 grid gap-2">
            <button type="button" className="outlineButton min-h-9 px-3 text-xs" disabled={isBusy || !displayGranted} onClick={() => void handleNotificationTest()}>10초 후 시험 알림</button>
            <button type="button" className="outlineButton min-h-9 px-3 text-xs" disabled={isBusy || !displayGranted} onClick={() => void handleNotificationResync()}>예약 다시 동기화</button>
          </div>
        </div>
      </div>
      {message && <p role="status" className="mt-3 text-xs text-[#1c7ba6]">{message}</p>}
    </section>
  );
}

/** Edits the ordered deterministic actions used only when no registered item can run. */
function SystemFallbackEditor({ initialFallbacks, save }: { initialFallbacks: SystemFallback[]; save: (fallbacks: SystemFallback[]) => Promise<void> }) {
  const [fallbacks, setFallbacks] = useState<SystemFallback[]>(initialFallbacks);
  const [message, setMessage] = useState("");
  const [isOpen, setIsOpen] = useState(false);

  /** Updates one fallback without changing its stable source identity. */
  function updateFallback(id: string, change: Partial<Pick<SystemFallback, "action" | "expectedMinutes" | "executionConstraints">>) {
    setFallbacks((current) => current.map((fallback) => fallback.id === id ? { ...fallback, ...change } : fallback));
  }

  /** Moves one fallback while retaining deterministic user-defined order. */
  function moveFallback(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= fallbacks.length) return;
    setFallbacks((current) => {
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  }

  /** Adds a bounded empty row that must be completed before saving. */
  function addFallback() {
    if (fallbacks.length >= 12) {
      setMessage("System fallback은 최대 12개까지 등록할 수 있습니다.");
      return;
    }
    setFallbacks((current) => [...current, { id: crypto.randomUUID(), action: "", expectedMinutes: 5 }]);
    setMessage("");
  }

  /** Keeps at least one fallback so the Planner always has a deterministic final layer. */
  function removeFallback(id: string) {
    if (fallbacks.length <= 1) {
      setMessage("System fallback은 최소 하나가 필요합니다.");
      return;
    }
    setFallbacks((current) => current.filter((fallback) => fallback.id !== id));
    setMessage("");
  }

  /** Validates and persists the complete ordered fallback list. */
  async function handleSave() {
    const normalized = fallbacks.map((fallback) => ({
      ...fallback,
      action: fallback.action.trim(),
      expectedMinutes: Math.round(fallback.expectedMinutes),
    }));
    if (normalized.some((fallback) => !fallback.action)) {
      setMessage("모든 fallback 지령 문구를 입력해 주세요.");
      return;
    }
    if (normalized.some((fallback) => fallback.action.length > 100)) {
      setMessage("fallback 지령 문구는 100자 이하여야 합니다.");
      return;
    }
    if (normalized.some((fallback) => !Number.isInteger(fallback.expectedMinutes) || fallback.expectedMinutes < 1 || fallback.expectedMinutes > 30)) {
      setMessage("예상 시간은 1분에서 30분 사이여야 합니다.");
      return;
    }
    if (new Set(normalized.map((fallback) => fallback.action)).size !== normalized.length) {
      setMessage("같은 fallback 지령 문구를 중복 등록할 수 없습니다.");
      return;
    }
    try {
      await save(normalized);
      setFallbacks(normalized);
      setMessage("System fallback 설정을 저장했습니다. 다음 fallback 지령부터 반영됩니다.");
    } catch {
      setMessage("System fallback 설정을 저장하지 못했습니다.");
    }
  }

  return (
    <section className="mt-6 border border-[#165b80] bg-[#071320] p-5 text-[#5cd0ff] sm:p-6 phoneLandscape:p-4">
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls="systemFallbackSettings"
        className={`flex w-full items-center justify-between gap-4 text-left ${isOpen ? "border-b border-[#165b80] pb-4" : ""}`}
        onClick={() => setIsOpen((current) => !current)}
      >
        <span>
          <span className="block text-xs font-bold tracking-[.17em]">PLANNER / SYSTEM FALLBACK</span>
          <span className="mt-2 block text-xs leading-5 text-[#567287]">등록된 실행 항목이 없을 때 위에서부터 결정론적으로 순환합니다.</span>
        </span>
        <span className="flex shrink-0 items-center gap-3 text-[10px] tracking-[.12em] text-[#1c7ba6]">
          {fallbacks.length} ITEMS
          <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center border border-[#165b80] text-base text-[#5cd0ff]">{isOpen ? "−" : "+"}</span>
        </span>
      </button>
      {isOpen && (
        <div id="systemFallbackSettings">
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button type="button" className="outlineButton min-h-9 px-3 text-xs" onClick={() => { setFallbacks(createDefaultSystemFallbacks()); setMessage("기본 목록을 불러왔습니다. 저장하면 적용됩니다."); }}>기본값 복원</button>
            <button type="button" className="outlineButton min-h-9 px-3 text-xs" onClick={addFallback}>+ 추가</button>
          </div>
          <div className="mt-4 space-y-3">
            {fallbacks.map((fallback, index) => (
              <div key={fallback.id} className="grid gap-2 border border-[#0d3850] bg-[#050e18] p-3 sm:grid-cols-[2rem_minmax(0,1fr)_6rem_auto] sm:items-center">
                <span className="text-center text-xs text-[#31536a]">{index + 1}</span>
                <input aria-label={`${index + 1}번째 fallback 지령 문구`} maxLength={100} value={fallback.action} onChange={(event) => updateFallback(fallback.id, { action: event.target.value })} className="terminalField min-w-0" placeholder="예: 창문을 열고 환기할 것." />
                <label className="flex items-center gap-2 text-xs"><input aria-label={`${index + 1}번째 fallback 예상 시간`} type="number" min={1} max={30} value={fallback.expectedMinutes} onChange={(event) => updateFallback(fallback.id, { expectedMinutes: Number(event.target.value) })} className="terminalField min-w-0" /><span>분</span></label>
                <div className="grid grid-cols-3 gap-1">
                  <button type="button" aria-label="위로 이동" className="outlineButton min-h-9 px-2 text-xs" disabled={index === 0} onClick={() => moveFallback(index, -1)}>↑</button>
                  <button type="button" aria-label="아래로 이동" className="outlineButton min-h-9 px-2 text-xs" disabled={index === fallbacks.length - 1} onClick={() => moveFallback(index, 1)}>↓</button>
                  <button type="button" aria-label="fallback 삭제" className="outlineButton min-h-9 px-2 text-xs text-[#e0717d]" onClick={() => removeFallback(fallback.id)}>×</button>
                </div>
                <div className="sm:col-span-4"><ExecutionConstraintsEditor value={fallback.executionConstraints} onChange={(executionConstraints) => updateFallback(fallback.id, { executionConstraints })} /></div>
              </div>
            ))}
          </div>
          <button type="button" className="terminalButton mt-4 min-h-11 w-full px-4 text-sm sm:w-auto sm:min-w-44" onClick={() => void handleSave()}>fallback 저장</button>
          {message && <p role="status" className="mt-3 text-xs text-[#1c7ba6]">{message}</p>}
        </div>
      )}
    </section>
  );
}

/** Displays the persisted deterministic Planner audit trail and supports copying it for bug reports. */
function PlannerDecisionHistory({ decisions }: { decisions: PlannerDecisionRecord[] }) {
  const [copyMessage, setCopyMessage] = useState("");

  /** Copies the bounded Planner history without changing stored application state. */
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(decisions, null, 2));
      setCopyMessage("판단 기록을 복사했습니다.");
    } catch {
      setCopyMessage("복사하지 못했습니다. 브라우저 권한을 확인해 주세요.");
    }
  }

  return (
    <section className="mt-6 min-w-0 border border-[#165b80] bg-[#050e18] p-5 text-[#5cd0ff] sm:p-6 phoneLandscape:p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#165b80] pb-4">
        <div>
          <p className="text-xs font-bold tracking-[.17em]">PLANNER / 판단 기록</p>
          <p className="mt-2 text-xs leading-5 text-[#567287]">최근 지령이 선택되거나 제외된 근거를 최대 50건 보존합니다.</p>
        </div>
        <button type="button" className="outlineButton min-h-9 px-3 py-1 text-xs" onClick={handleCopy} disabled={decisions.length === 0}>기록 JSON 복사</button>
      </div>
      {copyMessage && <p role="status" className="mt-3 text-xs text-[#1c7ba6]">{copyMessage}</p>}
      {decisions.length === 0 ? (
        <p className="py-8 text-center text-sm text-[#31536a]">아직 저장된 Planner 판단 기록이 없습니다.</p>
      ) : (
        <div className="mt-4 max-h-[36rem] space-y-3 overflow-y-auto pr-1">
          {decisions.map((decision, index) => (
            <details key={`${decision.ticketId}-${decision.evaluatedAt}`} open={index === 0} className="border border-[#0d3850] bg-[#071320] open:border-[#1c7ba6]">
              <summary className="cursor-pointer list-none px-4 py-3 marker:hidden">
                <span className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0 break-words text-sm font-bold">{decision.selectedAction}</span>
                  <time className="shrink-0 text-[10px] tracking-[.1em] text-[#31536a]">{formatPlannerDecisionTime(decision.evaluatedAt)}</time>
                </span>
                <span className="mt-2 block text-xs leading-5 text-[#567287]">가용 {decision.availableMinutes}분 · {decision.selectedReason}</span>
                {decision.userContext && <span className="mt-2 block text-[10px] text-[#31536a]">판단 당시 상태 / {describeUserContext(decision.userContext)}</span>}
              </summary>
              <ol className="border-t border-[#0d3850] px-4 py-3">
                {decision.candidates.map((candidate, candidateIndex) => (
                  <li key={`${candidate.sourceType}-${candidate.sourceId ?? candidate.label}-${candidateIndex}`} className="grid gap-1 border-b border-[#0a2637] py-2 last:border-b-0 sm:grid-cols-[5rem_1fr_auto] sm:gap-3">
                    <span className={`text-[10px] font-bold tracking-[.12em] ${getDispositionColor(candidate.disposition)}`}>{plannerDispositionLabels[candidate.disposition]}</span>
                    <span className="min-w-0 break-words text-xs text-[#8edfff]">{candidate.label}<span className="ml-2 text-[#31536a]">{candidate.sourceType}</span></span>
                    {candidate.score !== null && <span className="text-[10px] text-[#31536a]">이전 방식 점수 {candidate.score}</span>}
                    {candidate.lastExecutedAt !== undefined && (
                      <span className="text-[10px] text-[#31536a]">마지막 선택 {candidate.lastExecutedAt === null ? "없음" : formatPlannerDecisionTime(candidate.lastExecutedAt)}</span>
                    )}
                    <span className="text-[11px] leading-5 text-[#567287] sm:col-span-3">{candidate.reason}</span>
                    {candidate.originalMinutes !== undefined && candidate.adjustedMinutes !== undefined && candidate.originalMinutes !== candidate.adjustedMinutes && <span className="text-[10px] text-[#31536a] sm:col-span-3">수행 단위 {candidate.originalMinutes}→{candidate.adjustedMinutes}분</span>}
                  </li>
                ))}
              </ol>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}

/** Supplies local backup serialization and replacement actions to the settings panel. */
interface DataBackupPanelProps {
  exportBackup: () => string;
  importBackup: (payload: string) => Promise<string | null>;
}

/** Provides explicit file and clipboard backup controls without silently replacing local data. */
function DataBackupPanel({ exportBackup, importBackup }: DataBackupPanelProps) {
  const [pendingPayload, setPendingPayload] = useState<string | null>(null);
  const [pendingFileName, setPendingFileName] = useState("");
  const [message, setMessage] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [pastedPayload, setPastedPayload] = useState("");
  const [pendingSummary, setPendingSummary] = useState("");

  /** Validates either backup input and previews recoverable counts before allowing state replacement. */
  function stageBackupImport(payload: string, fileName: string) {
    setPendingPayload(null);
    setPendingFileName("");
    setPendingSummary("");
    if (new Blob([payload]).size > 5 * 1024 * 1024) {
      setMessage("백업은 5MB 이하여야 합니다.");
      return;
    }
    try {
      const restored = parseStateBackup(JSON.parse(payload) as unknown);
      if (!restored) {
        setMessage("지령 단말기 백업으로 확인되지 않습니다. 기존 데이터는 변경하지 않았습니다.");
        return;
      }
      setPendingPayload(payload);
      setPendingFileName(fileName);
      setPendingSummary(`할 일 ${restored.tasks.length}개 · 루틴 ${restored.idealRoutines.length}개 · 일정 ${restored.localScheduleItems.length}개 · 지령 이력 ${restored.tickets.length}개`);
      setMessage("백업 내용을 확인했습니다. 아래에서 복원을 확정해 주세요.");
    } catch {
      setMessage("JSON 형식이 올바르지 않습니다. 기존 데이터는 변경하지 않았습니다.");
    }
  }

  /** Downloads the complete current state as a versioned JSON file. */
  function handleDownload() {
    try {
      const blob = new Blob([exportBackup()], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `directive-terminal-backup-${createBackupDateStamp(new Date())}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setMessage("백업 파일을 내보냈습니다.");
    } catch {
      setMessage("백업 파일을 만들지 못했습니다.");
    }
  }

  /** Copies the complete backup text for environments where file downloads are inconvenient. */
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(exportBackup());
      setMessage("전체 백업 JSON을 복사했습니다.");
    } catch {
      setMessage("백업을 복사하지 못했습니다. 브라우저 권한을 확인해 주세요.");
    }
  }

  /** Reads a reasonably sized JSON file and waits for explicit replacement confirmation. */
  async function handleFileSelection(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setPendingPayload(null);
      setPendingFileName("");
      setPendingSummary("");
      setMessage("백업 파일은 5MB 이하여야 합니다.");
      return;
    }
    try {
      stageBackupImport(await file.text(), file.name);
    } catch {
      setMessage("선택한 파일을 읽지 못했습니다.");
    }
  }

  /** Validates and applies the selected backup after the second confirmation step. */
  async function handleImport() {
    if (!pendingPayload || isImporting) return;
    setIsImporting(true);
    try {
      const error = await importBackup(pendingPayload);
      if (error) {
        setMessage(error);
        return;
      }
      setPendingPayload(null);
      setPendingFileName("");
      setPendingSummary("");
      setPastedPayload("");
      setMessage("백업을 복원했습니다.");
    } catch {
      setMessage("백업을 복원하지 못했습니다. 기존 데이터는 유지됩니다.");
    } finally {
      setIsImporting(false);
    }
  }

  /** Clears a staged import without modifying the current state. */
  function handleCancelImport() {
    setPendingPayload(null);
    setPendingFileName("");
    setPendingSummary("");
    setMessage("복원을 취소했습니다.");
  }

  return (
    <section className="min-w-0 border border-[#165b80] bg-[#050e18] p-5 text-[#5cd0ff] sm:p-6 phoneLandscape:p-4">
      <div className="border-b border-[#165b80] pb-4">
        <p className="text-xs font-bold tracking-[.17em]">DATA / 백업 및 복원</p>
        <p className="mt-2 text-xs leading-5 text-[#567287]">할 일·루틴·지령 이력·설정을 하나의 JSON으로 보관합니다.</p>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3 phoneLandscape:grid-cols-1">
        <button type="button" className="terminalButton min-h-11 text-sm" onClick={handleDownload}>파일로 내보내기</button>
        <button type="button" className="outlineButton min-h-11 text-sm" onClick={() => void handleCopy()}>백업 JSON 복사</button>
        <label className="outlineButton flex min-h-11 cursor-pointer items-center justify-center text-sm">
          백업 파일 선택
          <input type="file" accept="application/json,.json" className="sr-only" onChange={(event) => void handleFileSelection(event)} />
        </label>
      </div>
      <details className="mt-4 border border-[#165b80] p-3">
        <summary className="cursor-pointer text-xs">복사한 백업 JSON으로 복원</summary>
        <p className="mt-3 text-xs leading-5 text-[#567287]">기존 앱에서 복사한 전체 백업 JSON을 붙여넣으세요. 확인 버튼만으로 현재 데이터가 바뀌지는 않습니다.</p>
        <textarea
          aria-label="백업 JSON 붙여넣기"
          className="mt-3 min-h-32 w-full border border-[#165b80] bg-black p-3 font-mono text-xs text-[#5cd0ff]"
          rows={6}
          maxLength={5 * 1024 * 1024}
          spellCheck={false}
          value={pastedPayload}
          onChange={(event) => setPastedPayload(event.target.value)}
        />
        <button type="button" className="outlineButton mt-3 min-h-10 w-full text-xs" disabled={!pastedPayload.trim() || isImporting} onClick={() => stageBackupImport(pastedPayload, "붙여넣은 백업 JSON")}>백업 내용 확인</button>
      </details>
      {pendingPayload && (
        <div className="mt-4 border border-[#2fbffc] bg-[#071320] p-4">
          <p className="break-all text-sm font-bold">{pendingFileName}</p>
          <p className="mt-2 text-xs leading-5 text-[#5cd0ff]">{pendingSummary}</p>
          <p className="mt-2 text-xs leading-5 text-[#e0717d]">복원하면 현재 브라우저의 모든 지령 단말기 데이터가 이 파일의 내용으로 교체됩니다.</p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <button type="button" className="outlineButton min-h-10 text-xs" disabled={isImporting} onClick={handleCancelImport}>취소</button>
            <button type="button" className="terminalButton min-h-10 text-xs" disabled={isImporting} onClick={() => void handleImport()}>이 데이터로 교체</button>
          </div>
        </div>
      )}
      {message && <p role="status" className="mt-4 text-xs text-[#1c7ba6]">{message}</p>}
    </section>
  );
}

/** Composes settings and backup controls side by side on landscape phones without an informational sidebar. */
export default function SettingsPage() {
  const { state, updateSettings, exportBackup, importBackup } = useLocalState();
  if (!state) return <p role="status">단말기 연결 중…</p>;
  return (
    <div className="w-full">
      <PageHeading code="SYSTEM / SETTINGS" title="설정" description="사용자 이름과 생활 리듬을 기록합니다. 데이터는 현재 브라우저에만 남습니다." />
      <UserContextControl className="mb-5" />
      {state.plannerDeferral && <section className="mb-5 border border-[#165b80] p-4 text-xs text-[#567287]"><p>발행 보류 / {state.plannerDeferral.reason}</p><p className="mt-2">판단 당시 상태 / {state.plannerDeferral.decision.userContext ? describeUserContext(state.plannerDeferral.decision.userContext) : "기록 없음"}</p><details className="mt-2"><summary className="cursor-pointer">보류 판단 JSON</summary><pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all text-[10px]">{JSON.stringify(state.plannerDeferral, null, 2)}</pre></details></section>}
      <div className="grid gap-6 phoneLandscape:grid-cols-2 phoneLandscape:items-start phoneLandscape:gap-4">
        <SettingsEditor key={`${state.settings.userName}-${state.settings.preferredBedtime}-${state.settings.preferredWakeTime}-${state.settings.tone}-${JSON.stringify(state.settings.systemFallbacks)}`} initialSettings={state.settings} save={updateSettings} />
        <DataBackupPanel exportBackup={exportBackup} importBackup={importBackup} />
      </div>
      <NotificationPermissionPanel state={state} />
      <CalendarWidgetPanel />
      <SystemFallbackEditor
        key={JSON.stringify(state.settings.systemFallbacks)}
        initialFallbacks={state.settings.systemFallbacks}
        save={(systemFallbacks) => updateSettings({ ...state.settings, systemFallbacks })}
      />
      <InvalidDirectiveHistory tickets={state.tickets} />
      <PlannerDecisionHistory decisions={state.plannerDecisions} />
    </div>
  );
}
