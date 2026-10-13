"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";
import { PageHeading } from "@/components/PageHeading";
import { InvalidDirectiveHistory } from "@/components/invalidDirectiveHistory";
import { useLocalState } from "@/lib/localState";
import type {
  PlannerCandidateDisposition,
  PlannerDecisionRecord,
  Settings,
} from "@/lib/ticketMachine";

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
      setMessage("백업 파일은 5MB 이하여야 합니다.");
      return;
    }
    try {
      setPendingPayload(await file.text());
      setPendingFileName(file.name);
      setMessage("파일을 읽었습니다. 아래에서 복원을 확정해 주세요.");
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
      {pendingPayload && (
        <div className="mt-4 border border-[#2fbffc] bg-[#071320] p-4">
          <p className="break-all text-sm font-bold">{pendingFileName}</p>
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
      <div className="grid gap-6 phoneLandscape:grid-cols-2 phoneLandscape:items-start phoneLandscape:gap-4">
        <SettingsEditor key={`${state.settings.userName}-${state.settings.preferredBedtime}-${state.settings.preferredWakeTime}-${state.settings.tone}`} initialSettings={state.settings} save={updateSettings} />
        <DataBackupPanel exportBackup={exportBackup} importBackup={importBackup} />
      </div>
      <InvalidDirectiveHistory tickets={state.tickets} />
      <PlannerDecisionHistory decisions={state.plannerDecisions} />
    </div>
  );
}
