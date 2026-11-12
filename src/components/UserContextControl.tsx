"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useLocalState } from "@/lib/localState";
import { getActiveTicket } from "@/lib/ticketMachine";
import { planNextTicketWithDecision } from "@/lib/planner";
import { playTicketSignalUntilSettled } from "@/lib/ticketSignal";
import {
  actionCapabilityLabels, createDefaultUserContext, describeUserContext, getActiveContextConflict,
  resolveEffectiveContext, userActivityLabels, userFatigueLabels,
  type ActionCapability, type UserActivity, type UserContext, type UserFatigue,
} from "@/lib/userContext";

/** Formats a full instant for a local datetime input, preserving its local calendar date. */
function toLocalInput(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Converts a validated local datetime selection into the storage-wide ISO timestamp format. */
function fromLocalInput(value: string): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

/** Provides a compact status control and explicit context-cancellation confirmation without replacing main actions. */
export function UserContextControl({ className = "" }: { className?: string }) {
  const { state, saveUserContext, replanUserContext } = useLocalState();
  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState<UserContext>(createDefaultUserContext);
  const [confirmedTicketId, setConfirmedTicketId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!isOpen && !confirmedTicketId) return;
    /** Closes only this control's non-saving dialog on Escape. */
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !isSaving) { setIsOpen(false); setConfirmedTicketId(null); }
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isOpen, confirmedTicketId, isSaving]);

  if (!state) return null;
  const effective = resolveEffectiveContext(state.userContext, now);
  const active = getActiveTicket(state);
  const conflict = active ? getActiveContextConflict(state, active, now) : null;

  /** Loads effective context only when opening, so background expiry cannot overwrite an in-progress draft. */
  function openEditor() {
    if (!state) return;
    setDraft(resolveEffectiveContext(state.userContext, new Date()));
    setError(""); setConfirmedTicketId(null); setIsOpen(true);
  }

  /** Saves context first, preserving ACTIVE; asks separately before any context-driven cancellation. */
  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state || isSaving) return;
    const currentTime = new Date();
    if ([draft.activityUntil, draft.fatigueUntil, draft.capabilitiesUntil].some((time) => time && new Date(time) <= currentTime)) {
      setError("종료 예정 시각은 현재보다 나중으로 설정하거나 비워 주세요."); return;
    }
    setIsSaving(true); setError("");
    try {
      const success = await saveUserContext(draft);
      if (!success) { setError("현재 상태를 저장하지 못했습니다."); return; }
      setIsOpen(false); setNow(currentTime);
      if (active && getActiveContextConflict({ ...state, userContext: draft }, active, currentTime)) setConfirmedTicketId(active.id);
    } catch { setError("현재 상태를 저장하지 못했습니다. 다시 시도해 주세요."); }
    finally { setIsSaving(false); }
  }

  /** Confirms against the captured ACTIVE ID and plays issuance audio only when a real replacement is possible. */
  async function handleReplan() {
    if (!state || !confirmedTicketId || isSaving) return;
    setIsSaving(true); setError("");
    try {
      const prediction = planNextTicketWithDecision({ now: new Date(), tasks: state.tasks, localSchedule: state.localScheduleItems,
        idealRoutines: state.idealRoutines, recentTickets: state.tickets, settings: state.settings, userContext: state.userContext });
      const operation = replanUserContext(confirmedTicketId);
      const [success] = await Promise.all([operation, prediction.kind === "DIRECTIVE" ? playTicketSignalUntilSettled(operation) : Promise.resolve()]);
      if (!success) { setError("현재 지령 또는 상태가 변경되어 재계획하지 않았습니다. 창을 닫고 다시 확인해 주세요."); return; }
      setConfirmedTicketId(null);
    } catch { setError("재계획을 저장하지 못했습니다. 현재 지령을 다시 확인해 주세요."); }
    finally { setIsSaving(false); }
  }

  return (
    <div className={className}>
      <button type="button" onClick={openEditor} className="max-w-full truncate border border-[#0d3043] bg-black px-2 py-1 text-[10px] text-[#31536a] hover:border-[#1c7ba6] hover:text-[#5cd0ff]" aria-label="현재 사용자 상태 설정">
        상태 / {describeUserContext(effective)}
      </button>
      {conflict && <div className="mt-2 max-w-md text-[11px] leading-5 text-[#a77f52]">
        <p>현재 지령과 상태가 맞지 않습니다. 지령은 유지 중입니다.</p>
        <button type="button" onClick={() => { setError(""); setConfirmedTicketId(active?.id ?? null); }} className="underline underline-offset-4">상황 변경 후 재계획</button>
      </div>}
      {isOpen && <div data-pin-terminal-navigation="true" className="terminalDialogOverlay fixed inset-0 z-50 flex items-end justify-center bg-black/85 sm:items-center" onMouseDown={(event) => { if (event.target === event.currentTarget && !isSaving) setIsOpen(false); }}>
        <section role="dialog" aria-modal="true" aria-labelledby="userContextTitle" className="terminalDialogPanel w-full max-w-lg border border-[#165b80] bg-[#02080d] p-5 text-[#5cd0ff]">
          <div className="mb-4 flex items-center justify-between gap-3"><h2 id="userContextTitle" className="text-xl">현재 상태</h2><button type="button" disabled={isSaving} aria-label="현재 상태 창 닫기" onClick={() => setIsOpen(false)} className="h-9 w-9 border border-[#165b80]">×</button></div>
          <form onSubmit={(event) => void handleSave(event)} className="space-y-4">
            <fieldset disabled={isSaving} className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs">현재 활동<select className="terminalField mt-2" value={draft.activity} onChange={(event) => setDraft({ ...draft, activity: event.target.value as UserActivity })}>{(Object.keys(userActivityLabels) as UserActivity[]).map((value) => <option key={value} value={value}>{userActivityLabels[value]}</option>)}</select></label>
              <label className="text-xs">활동 종료 예정<input className="terminalField mt-2" type="datetime-local" value={toLocalInput(draft.activityUntil)} onChange={(event) => setDraft({ ...draft, activityUntil: fromLocalInput(event.target.value) })} /></label>
              <label className="text-xs">몸 상태<select className="terminalField mt-2" value={draft.fatigue} onChange={(event) => setDraft({ ...draft, fatigue: event.target.value as UserFatigue })}>{(Object.keys(userFatigueLabels) as UserFatigue[]).map((value) => <option key={value} value={value}>{userFatigueLabels[value]}</option>)}</select></label>
              <label className="text-xs">몸 상태 해제 예정<input className="terminalField mt-2" type="datetime-local" value={toLocalInput(draft.fatigueUntil)} onChange={(event) => setDraft({ ...draft, fatigueUntil: fromLocalInput(event.target.value) })} /></label>
              <div className="sm:col-span-2"><p className="mb-2 text-xs">지금 수행할 수 없는 행동</p><div className="grid grid-cols-2 gap-2 text-xs">{(Object.keys(actionCapabilityLabels) as ActionCapability[]).map((capability) => <label key={capability} className="flex items-center gap-2"><input type="checkbox" className="accent-[#2fbffc]" checked={draft.blockedCapabilities.includes(capability)} onChange={(event) => setDraft({ ...draft, blockedCapabilities: event.target.checked ? [...draft.blockedCapabilities, capability] : draft.blockedCapabilities.filter((item) => item !== capability) })} />{actionCapabilityLabels[capability]}</label>)}</div></div>
              <label className="text-xs sm:col-span-2">수행 제한 해제 예정<input className="terminalField mt-2" type="datetime-local" value={toLocalInput(draft.capabilitiesUntil)} onChange={(event) => setDraft({ ...draft, capabilitiesUntil: fromLocalInput(event.target.value) })} /></label>
            </fieldset>
            <p className="text-[10px] leading-5 text-[#567287]">시각을 비우면 직접 해제할 때까지 유지합니다. 세 종료 시각은 독립적입니다. 피곤함은 지속형 수행 단위를 최대 15분, 몸 상태가 좋지 않으면 10분으로 줄입니다. 기존 지령은 확인 없이 취소하지 않습니다.</p>
            {error && <p role="alert" className="text-xs text-[#ff5b6e]">{error}</p>}
            <div className="grid grid-cols-2 gap-3"><button type="button" disabled={isSaving} className="outlineButton text-xs" onClick={() => setDraft(createDefaultUserContext())}>기본 상태로</button><button type="submit" disabled={isSaving} className="terminalButton text-xs">상태 저장</button></div>
          </form>
        </section>
      </div>}
      {confirmedTicketId && <div data-pin-terminal-navigation="true" className="terminalDialogOverlay fixed inset-0 z-50 flex items-end justify-center bg-black/85 sm:items-center">
        <section role="dialog" aria-modal="true" aria-labelledby="contextReplanTitle" className="terminalDialogPanel w-full max-w-md border border-[#165b80] bg-[#02080d] p-5 text-[#5cd0ff]">
          <h2 id="contextReplanTitle" className="text-lg">현재 지령을 취소하고 다시 판단할까요?</h2>
          <p className="mt-4 text-xs leading-6 text-[#567287]">{active?.id === confirmedTicketId ? conflict : "현재 지령이 변경되었습니다."}</p>
          <p className="mt-3 text-xs leading-6 text-[#567287]">상황 변경 취소로 이력을 보존하며 수행 실패나 이상 지령으로 집계하지 않습니다. 수행 불가 상태라면 새 지령 없이 발행을 보류합니다.</p>
          {error && <p role="alert" className="mt-3 text-xs text-[#ff5b6e]">{error}</p>}
          <div className="mt-5 grid grid-cols-2 gap-3"><button type="button" className="outlineButton text-xs" disabled={isSaving} onClick={() => setConfirmedTicketId(null)}>현재 지령 유지</button><button type="button" className="terminalButton text-xs" disabled={isSaving || !conflict || active?.id !== confirmedTicketId} onClick={() => void handleReplan()}>취소 후 재계획</button></div>
        </section>
      </div>}
    </div>
  );
}
