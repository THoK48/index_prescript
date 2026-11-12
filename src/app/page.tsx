"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { DecryptingText } from "@/components/DecryptingText";
import { UserContextControl } from "@/components/UserContextControl";
import { planNextTicketWithDecision } from "@/lib/planner";
import { contextDirectiveIssuedEvent, resolveEffectiveContext } from "@/lib/userContext";
import { formatDirectiveTiming, getOverdueTaskDeadline } from "@/lib/directiveTiming";
import {
  getActiveTicket,
  getActiveTicketStaleness,
  getTicketExpectedEndAt,
  isUnlimitedDurationTicket,
  type FailureReason,
  type InvalidDirectiveReason,
  type Ticket,
} from "@/lib/ticketMachine";
import { playFailureAlertSound, playInformationBeepSound, playTicketSignalUntilSettled, tryPlayTicketSignal } from "@/lib/ticketSignal";
import { useLocalState } from "@/lib/localState";
import { invalidDirectiveReasonLabels, invalidDirectiveReasons } from "@/lib/directiveFeedback";

const initialSignalRetryEvents = ["pointerdown", "keydown"] as const;

const failureReasons: { value: FailureReason; label: string }[] = [
  { value: "time_shortage", label: "시간이 부족함" },
  { value: "time_elapsed", label: "시간 경과 / 놓침" },
  { value: "physical_condition", label: "피곤함 / 몸 상태" },
  { value: "schedule_changed", label: "일정이 변경됨" },
  { value: "place_or_tools", label: "장소 / 도구 문제" },
  { value: "too_difficult", label: "예상보다 어려움" },
  { value: "other", label: "기타" },
];

/** Normalizes the visible action sentence without exposing recipient or Planner trigger metadata. */
function formatDirectiveAction(ticket: Ticket): string {
  const action = ticket.action.trim();
  if (isUnlimitedDurationTicket(ticket)) return action;
  return /[.!?。]$/.test(action) ? action : `${action}.`;
}

/** Blends one color channel without allowing audio timing jitter outside the valid range. */
function blendFailureChannel(start: number, end: number, progress: number): number {
  const normalizedProgress = Math.min(1, Math.max(0, progress));
  return Math.round(start + (end - start) * normalizedProgress);
}

/** Creates CSS variables that move the active directive from terminal cyan to muted failure red. */
function createFailureVisualStyle(progress: number): CSSProperties {
  const normalizedProgress = Math.min(1, Math.max(0, progress));
  const ink = [
    blendFailureChannel(92, 232, normalizedProgress),
    blendFailureChannel(208, 72, normalizedProgress),
    blendFailureChannel(255, 88, normalizedProgress),
  ];
  const dim = [
    blendFailureChannel(28, 153, normalizedProgress),
    blendFailureChannel(123, 46, normalizedProgress),
    blendFailureChannel(166, 58, normalizedProgress),
  ];
  return {
    color: `rgb(${ink.join(" ")})`,
    "--failure-progress": normalizedProgress,
    "--failure-ink": `rgb(${ink.join(" ")})`,
    "--failure-dim": `rgb(${dim.join(" ")})`,
    "--failure-glow": `rgba(232, 72, 88, ${0.12 + normalizedProgress * 0.55})`,
    "--failure-overlay": `rgba(94, 8, 19, ${normalizedProgress * 0.3})`,
  } as CSSProperties;
}

/** Provides a readable fallback explanation for tickets saved before planner reasons existed. */
function formatSelectionReason(ticket: Ticket): string {
  if (ticket.selectionReason) {
    return ticket.selectionReason.replace(/\s*· System 순환 \d+\/\d+$/, "");
  }
  if (ticket.sourceType === "ROUTINE") return "현재 루틴 시간대";
  if (ticket.sourceType === "SCHEDULE") return "현재 시각과 고정 일정";
  if (ticket.sourceType === "TASK") return "마감 · 중요도 · 가용 시간";
  return "현재 실행 가능한 등록 항목 없음";
}

/** Counts today's completed and failed executions using local calendar dates. */
function getTodayExecutionCounts(tickets: Ticket[], now: Date): { completed: number; failed: number } {
  let completed = 0;
  let failed = 0;
  for (const ticket of tickets) {
    if (!ticket.completedAt) continue;
    const completedAt = new Date(ticket.completedAt);
    const isToday = completedAt.getFullYear() === now.getFullYear()
      && completedAt.getMonth() === now.getMonth()
      && completedAt.getDate() === now.getDate();
    if (!isToday) continue;
    if (ticket.status === "COMPLETED") completed += 1;
    if (ticket.status === "FAILED") failed += 1;
  }
  return { completed, failed };
}

/** Presents one active directive with compact landscape controls and height-bounded report dialogs. */
export default function HomePage() {
  const { state, issue, continueActive, completeAndReissue, failAndReissue, invalidateAndReissue } = useLocalState();
  const [failureReason, setFailureReason] = useState<FailureReason>("time_shortage");
  const [isFailOpen, setIsFailOpen] = useState(false);
  const [isReasonOpen, setIsReasonOpen] = useState(false);
  const [invalidTicketId, setInvalidTicketId] = useState<string | null>(null);
  const [invalidReason, setInvalidReason] = useState<InvalidDirectiveReason>("TIME_IMPOSSIBLE");
  const [invalidError, setInvalidError] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failurePlaybackProgress, setFailurePlaybackProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(() => new Date());
  const [dismissedStaleTicketId, setDismissedStaleTicketId] = useState<string | null>(null);
  const hasStartedEntrySignalRef = useRef(false);
  const ticket = state ? getActiveTicket(state) : null;
  const overdueTaskDeadline = ticket ? getOverdueTaskDeadline(ticket) : null;
  const lastTicket = state?.tickets[0];
  const todayExecutionCounts = getTodayExecutionCounts(state?.tickets ?? [], currentTime);
  const ticketStaleness = ticket ? getActiveTicketStaleness(ticket, currentTime) : null;
  const expectedEndAt = ticket && !isUnlimitedDurationTicket(ticket) ? getTicketExpectedEndAt(ticket) : null;
  const elapsedExpectedMinutes = expectedEndAt && expectedEndAt <= currentTime
    ? Math.max(1, Math.floor((currentTime.getTime() - expectedEndAt.getTime()) / 60_000))
    : 0;
  const failureVisualStyle = createFailureVisualStyle(failurePlaybackProgress);
  const isStalePromptOpen = Boolean(
    ticket
    && ticketStaleness
    && dismissedStaleTicketId !== ticket.id
    && !isBusy
    && invalidTicketId !== ticket.id
    && !isFailOpen,
  );

  useEffect(() => {
    const intervalId = window.setInterval(() => setCurrentTime(new Date()), 60_000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    /** Initial entry already owns the first sound; later context-driven ACTIVE transitions need their own signal. */
    function playContextIssueSignal() {
      if (hasStartedEntrySignalRef.current) void tryPlayTicketSignal();
    }
    window.addEventListener(contextDirectiveIssuedEvent, playContextIssueSignal);
    return () => window.removeEventListener(contextDirectiveIssuedEvent, playContextIssueSignal);
  }, []);

  useEffect(() => {
    if (!state || !ticket || hasStartedEntrySignalRef.current) return undefined;
    hasStartedEntrySignalRef.current = true;

    let isDisposed = false;
    let isAttempting = false;

    /** Removes gesture fallbacks after playback succeeds or the route unmounts. */
    function removeRetryListeners() {
      for (const eventName of initialSignalRetryEvents) {
        window.removeEventListener(eventName, requestInitialSignal, true);
      }
    }

    /** Attempts playback once and keeps gesture fallbacks only when autoplay was blocked. */
    async function attemptInitialSignal() {
      if (isDisposed || isAttempting) return;
      isAttempting = true;
      const didPlay = await tryPlayTicketSignal();
      isAttempting = false;
      if (didPlay) {
        removeRetryListeners();
      }
    }

    /** Retries the sound within the browser's first allowed user gesture. */
    function requestInitialSignal() {
      void attemptInitialSignal();
    }

    for (const eventName of initialSignalRetryEvents) {
      window.addEventListener(eventName, requestInitialSignal, true);
    }
    void attemptInitialSignal();

    return () => {
      isDisposed = true;
      removeRetryListeners();
    };
  }, [state, ticket]);

  /** Resolves the current ticket and reveals its replacement while the reference sound plays. */
  async function handleReissue(action: () => Promise<boolean>, successMessage: string): Promise<boolean> {
    setIsBusy(true);
    setIsFailOpen(false);
    setIsReasonOpen(false);
    setInvalidTicketId(null);
    setMessage("결과 기록 및 지령 재발급 중…");
    try {
      const actionPromise = action();
      const soundPromise = state && resolveEffectiveContext(state.userContext, new Date()).activity === "UNAVAILABLE"
        ? Promise.resolve() : playTicketSignalUntilSettled(actionPromise);
      const [, success] = await Promise.all([soundPromise, actionPromise]);
      setMessage(success ? successMessage : "현재 지령 상태가 변경되었습니다. 화면을 확인해 주세요.");
      return success;
    } catch {
      setMessage("상태를 저장하지 못했습니다. 다시 시도해 주세요.");
      return false;
    } finally {
      setIsBusy(false);
    }
  }

  /** Issues the first ticket while the bundled reference sound is playing. */
  async function handleIssue() {
    setIsBusy(true);
    setMessage("신호 수신 및 지령 발행 중…");
    try {
      const prediction = state ? planNextTicketWithDecision({ now: new Date(), tasks: state.tasks,
        localSchedule: state.localScheduleItems, idealRoutines: state.idealRoutines, recentTickets: state.tickets,
        settings: state.settings, userContext: state.userContext }) : null;
      if (prediction?.kind === "DIRECTIVE") hasStartedEntrySignalRef.current = true;
      const issuePromise = issue();
      const soundPromise = prediction?.kind === "DIRECTIVE" ? playTicketSignalUntilSettled(issuePromise) : Promise.resolve();
      const [, success] = await Promise.all([soundPromise, issuePromise]);
      setMessage(success ? prediction?.kind === "DEFERRED" ? "현재 상태에 따라 지령 발행을 보류했습니다." : "새 지령이 발행되었습니다." : "현재 지령 상태가 변경되었습니다. 화면을 확인해 주세요.");
    } catch {
      setMessage("상태를 저장하지 못했습니다. 다시 시도해 주세요.");
    } finally {
      setIsBusy(false);
    }
  }

  /** Keeps the current directive ACTIVE and postpones its result reminder by ten minutes. */
  async function handleContinue(ticketId: string) {
    setIsBusy(true);
    setMessage("현재 지령을 계속 수행하도록 알림 시각을 조정 중…");
    try {
      const success = await continueActive(ticketId, 10);
      setCurrentTime(new Date());
      setMessage(success ? "지령은 ACTIVE 상태로 유지되며 10분 뒤 다시 확인합니다." : "현재 지령이 변경되었습니다. 화면을 확인해 주세요.");
    } catch {
      setMessage("계속 수행 상태를 저장하지 못했습니다.");
    } finally {
      setIsBusy(false);
    }
  }

  /** Records a stale directive as elapsed and atomically replaces it with a fresh Planner result. */
  async function handleStaleReplan(ticketId: string) {
    setDismissedStaleTicketId(ticketId);
    const success = await handleReissue(
      () => failAndReissue(ticketId, "time_elapsed"),
      "시간이 지난 지령을 실패로 기록하고 다음 지령을 재발급했습니다.",
    );
    if (!success) setDismissedStaleTicketId(null);
  }

  /** Plays failure feedback fully, then sounds the normal issue signal while replacing the directive. */
  async function handleFailureAndReissue(ticketId: string) {
    if (isBusy) return;
    setIsBusy(true);
    setIsFailOpen(false);
    setIsReasonOpen(false);
    setInvalidTicketId(null);
    setMessage("실패 알림음 재생 중…");
    setFailurePlaybackProgress(0.001);
    try {
      await playFailureAlertSound(setFailurePlaybackProgress);
      setFailurePlaybackProgress(0);
      setMessage("실패 기록 및 지령 재발급 중…");
      const reissuePromise = failAndReissue(ticketId, failureReason);
      const issueSoundPromise = state && resolveEffectiveContext(state.userContext, new Date()).activity === "UNAVAILABLE"
        ? Promise.resolve() : playTicketSignalUntilSettled(reissuePromise);
      const [, success] = await Promise.all([issueSoundPromise, reissuePromise]);
      setMessage(success ? "실패 사유가 기록되고 다음 지령이 재발급되었습니다." : "현재 지령 상태가 변경되었습니다. 화면을 확인해 주세요.");
      if (success) setFailureReason("time_shortage");
    } catch {
      setMessage("실패 상태를 저장하지 못했습니다. 다시 시도해 주세요.");
    } finally {
      setFailurePlaybackProgress(0);
      setIsBusy(false);
    }
  }

  /** Acknowledges stale review while retaining the same ACTIVE directive and moving its reminder. */
  async function handleStaleContinue(ticketId: string) {
    setDismissedStaleTicketId(ticketId);
    await handleContinue(ticketId);
  }

  /** Opens quality feedback for the current ticket identity without resolving it yet. */
  function openInvalidFeedback(ticketId: string) {
    setInvalidReason("TIME_IMPOSSIBLE");
    setInvalidError("");
    setIsFailOpen(false);
    setInvalidTicketId(ticketId);
  }

  /** Toggles Planner details immediately and plays the attached beep only when opening them. */
  function toggleSelectionReason() {
    const shouldOpen = !isReasonOpen;
    if (shouldOpen) {
      void playInformationBeepSound();
    }
    setIsReasonOpen(shouldOpen);
  }

  /** Records the selected quality reason and reissues; a stale report never applies to a replacement ticket. */
  async function handleInvalidFeedback() {
    if (!invalidTicketId || isBusy) return;
    const reportingId = invalidTicketId;
    const success = await handleReissue(
      () => invalidateAndReissue(reportingId, invalidReason),
      "이상 지령 사유를 기록하고 다음 지령을 발행했습니다. 실패 횟수에는 포함하지 않습니다.",
    );
    if (!success) {
      setInvalidError("기록하지 못했거나 현재 지령이 변경되었습니다. 상태를 확인한 뒤 다시 시도해 주세요.");
      setInvalidTicketId(reportingId);
    }
  }

  if (!state) return <p role="status" className="mt-16 text-center text-[#1c7ba6]">단말기 연결 중…</p>;

  return (
    <div className="relative flex flex-1 flex-col items-center justify-center pb-8 phoneLandscape:justify-start phoneLandscape:pb-0">
      <UserContextControl className="absolute inset-x-0 top-8 z-10 mx-auto w-full max-w-2xl px-1 sm:px-4 phoneLandscape:static phoneLandscape:mb-3 phoneLandscape:max-w-4xl phoneLandscape:px-0" />
      {ticket && (
        <div className="terminalDotMeta absolute inset-x-0 top-0 mx-auto flex w-full max-w-2xl items-center justify-between gap-4 px-1 text-xs tracking-[.08em] text-[#1c7ba6] sm:px-4 phoneLandscape:static phoneLandscape:mb-3 phoneLandscape:max-w-4xl phoneLandscape:px-0">
          <span><DecryptingText text={`수행 완료: ${todayExecutionCounts.completed}`} delayMs={60} /></span>
          <span><DecryptingText text={`수행 실패: ${todayExecutionCounts.failed}`} delayMs={90} /></span>
        </div>
      )}
      <div className="w-full min-w-0 max-w-2xl phoneLandscape:grid phoneLandscape:max-w-4xl phoneLandscape:grid-cols-[minmax(0,1fr)_8rem] phoneLandscape:items-start phoneLandscape:gap-6">
        {ticket ? (
          <>
            <article
              key={ticket.id}
              className="directivePanel failureDirective relative min-w-0 px-1 py-8 [overflow-wrap:anywhere] sm:px-4 sm:py-10 phoneLandscape:px-0 phoneLandscape:py-1"
              aria-label="현재 지령"
              aria-busy={failurePlaybackProgress > 0}
              data-failure-active={failurePlaybackProgress > 0}
              style={failureVisualStyle}
            >
              <div className="failureDirectiveBody text-[24px] font-normal leading-[1.5] tracking-normal sm:text-[36px] sm:leading-[1.3334] phoneLandscape:text-[24px] phoneLandscape:leading-[1.5]">
                <p className="mb-6 text-xs tracking-[.08em] sm:mb-7 phoneLandscape:mb-3">
                  <DecryptingText text={`[${ticket.recipient}에게]`} delayMs={120} />
                </p>
                <p><DecryptingText text={formatDirectiveTiming(ticket)} delayMs={180} /></p>
                <p className="mt-3 sm:mt-5 phoneLandscape:mt-2"><DecryptingText text={formatDirectiveAction(ticket)} delayMs={240} /></p>
              </div>
              <div className="failureDirectiveMeta terminalDotMeta mt-10 flex items-center gap-2 text-xs tracking-[.08em] phoneLandscape:mt-5">
                <span><DecryptingText text={`발행 ${new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ticket.createdAt))}`} delayMs={420} /></span>
                <button
                  type="button"
                  aria-label="지령 정보 보기"
                  aria-expanded={isReasonOpen}
                  className="group flex h-5 w-5 items-center justify-center text-[#183447] opacity-45 transition-colors hover:text-[#5cd0ff] hover:opacity-100 focus-visible:text-[#5cd0ff]"
                  onClick={toggleSelectionReason}
                >
                  <span className="flex h-3 w-3 items-center justify-center rounded-full border border-[#0d2839] text-[7px] font-bold lowercase leading-none group-hover:border-[#1c7ba6] group-focus-visible:border-[#2fbffc]"><DecryptingText text="i" delayMs={450} /></span>
                </button>
              </div>
              {isReasonOpen && (
                <div className="mt-2 border-l border-[#165b80] pl-2 text-[10px] tracking-[.1em] text-[#31536a]">
                  {ticket.sourceType === "ROUTINE" && ticket.routineTitle && (
                    <div className="mb-3 space-y-1 border-b border-[#0d2839] pb-3">
                      <p><DecryptingText text={`상위 루틴 / ${ticket.routineTitle}`} delayMs={30} /></p>
                      <p><DecryptingText text={`현재 진행 단계 / ${ticket.routineStepIndex ?? 1}/${ticket.routineStepCount ?? 1}`} delayMs={35} /></p>
                    </div>
                  )}
                  <p role="status"><DecryptingText text={`선택 근거 / ${formatSelectionReason(ticket)}`} delayMs={40} /></p>
                  {overdueTaskDeadline && <p className="mt-2"><DecryptingText text={`원래 할 일 마감 / ${new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: false }).format(overdueTaskDeadline)} · 기한 지남`} delayMs={60} /></p>}
                  <p className="mt-3"><DecryptingText text="이 지령이 적절하지 않나요?" delayMs={80} /></p>
                  <button type="button" disabled={isBusy} className="mt-1 min-h-9 text-left text-[#567287] underline decoration-[#165b80] underline-offset-4 hover:text-[#5cd0ff]" onClick={() => openInvalidFeedback(ticket.id)}><DecryptingText text="이상 지령으로 기록" delayMs={100} /></button>
                </div>
              )}
            </article>
            {elapsedExpectedMinutes > 0 && (
              <div className="border border-[#e0a55b] bg-[#120d08] px-4 py-3 text-[#f0bc77] phoneLandscape:mt-2">
                <p className="text-sm font-bold">예상 종료 시각에서 {elapsedExpectedMinutes}분 경과</p>
                <p className="mt-1 text-[11px] leading-5 text-[#a77f52]">자동으로 완료·실패 처리되지 않았습니다. 결과를 기록하거나 계속 수행하세요.</p>
              </div>
            )}
            <div className={`mt-5 grid gap-3 phoneLandscape:mt-4 ${elapsedExpectedMinutes > 0 ? "grid-cols-3 phoneLandscape:grid-cols-3" : "grid-cols-2 phoneLandscape:grid-cols-1"}`}>
              <button className="terminalButton" disabled={isBusy} onClick={() => handleReissue(() => completeAndReissue(ticket.id), "완료가 기록되고 다음 지령이 재발급되었습니다.")}>완료</button>
              <button className="outlineButton" disabled={isBusy} onClick={() => setIsFailOpen(true)}>실패</button>
              {elapsedExpectedMinutes > 0 && <button className="outlineButton" disabled={isBusy} onClick={() => void handleContinue(ticket.id)}>계속 수행</button>}
            </div>
          </>
        ) : (
          <section className="border border-[#165b80] bg-[#050e18] px-6 py-10 text-center shadow-[0_0_24px_#2fbffc17] sm:px-12 sm:py-14 phoneLandscape:col-span-2 phoneLandscape:px-6 phoneLandscape:py-5">
            <div className="mx-auto mb-7 flex h-16 w-16 items-center justify-center border border-[#2fbffc] text-3xl text-[#5cd0ff] shadow-[0_0_14px_#2fbffc33] phoneLandscape:mb-3 phoneLandscape:h-10 phoneLandscape:w-10 phoneLandscape:text-xl" aria-hidden="true">⌁</div>
            <p className="mb-3 text-xs tracking-[.22em] text-[#1c7ba6]">NO ACTIVE DIRECTIVE</p>
            <h1 className="mb-4 text-3xl font-bold sm:text-4xl phoneLandscape:mb-2 phoneLandscape:text-2xl">{state.plannerDeferral ? "지령 발행 보류" : "현재 지령 없음"}</h1>
            <p className="mx-auto mb-9 max-w-sm text-sm leading-7 text-[#567287] phoneLandscape:mb-4 phoneLandscape:max-w-xl phoneLandscape:leading-5">
              {state.plannerDeferral ? state.plannerDeferral.reason : lastTicket ? "이전 지령이 처리되었습니다. 준비되면 다음 지령을 발행하세요." : "준비되면 첫 지령을 발행하세요. 한 번에 하나의 행동만 표시됩니다."}
            </p>
            {state.plannerDeferral?.resumeAt && <p className="mb-4 text-xs text-[#31536a]">다음 상태 해제 예정 / {new Date(state.plannerDeferral.resumeAt).toLocaleString("ko-KR")}</p>}
            <button className="terminalButton w-full max-w-xs" disabled={isBusy} onClick={handleIssue}>{state.plannerDeferral ? "현재 상태로 다시 판단" : "지령 발행"}</button>
          </section>
        )}

        {message && <p role="status" className="sr-only">{message}</p>}
      </div>

      {invalidTicketId === ticket?.id && ticket && (
        <div data-pin-terminal-navigation="true" className="terminalDialogOverlay fixed inset-0 z-30 flex items-end justify-center bg-black/80 sm:items-center phoneLandscape:items-start" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !isBusy) setInvalidTicketId(null); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="invalidDirectiveTitle" className="terminalDialogPanel w-full max-w-md border border-[#2fbffc] bg-[#050e18] p-6 shadow-[0_0_30px_#2fbffc33] phoneLandscape:max-w-2xl phoneLandscape:p-4">
            <h2 id="invalidDirectiveTitle" className="mb-3 text-2xl font-bold phoneLandscape:text-xl">이상 지령 사유</h2>
            <p className="mb-5 text-sm leading-6 text-[#567287]">이 기록은 사용자 실패 횟수에 포함되지 않습니다.</p>
            {invalidError && <p role="alert" className="mb-4 text-xs leading-5 text-[#e0717d]">{invalidError}</p>}
            <fieldset className="space-y-2 phoneLandscape:grid phoneLandscape:grid-cols-2 phoneLandscape:gap-2 phoneLandscape:space-y-0">
              <legend className="sr-only">이상 지령 사유</legend>
              {invalidDirectiveReasons.map((reason) => (
                <label key={reason} className={`flex min-h-12 cursor-pointer items-center gap-3 border px-3 py-2 text-sm ${invalidReason === reason ? "border-[#2fbffc] bg-[#072233] text-[#5cd0ff]" : "border-[#165b80]"}`}>
                  <input type="radio" name="invalidReason" value={reason} checked={invalidReason === reason} disabled={isBusy} onChange={() => setInvalidReason(reason)} className="accent-[#2fbffc]" />
                  {invalidDirectiveReasonLabels[reason]}
                </label>
              ))}
            </fieldset>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button type="button" className="outlineButton" disabled={isBusy} onClick={() => setInvalidTicketId(null)}>취소</button>
              <button type="button" className="terminalButton" disabled={isBusy} onClick={() => void handleInvalidFeedback()}>기록 후 재계획</button>
            </div>
          </section>
        </div>
      )}

      {isStalePromptOpen && ticket && ticketStaleness && (
        <div data-pin-terminal-navigation="true" className="terminalDialogOverlay fixed inset-0 z-30 flex items-end justify-center bg-black/80 sm:items-center phoneLandscape:items-start" role="presentation">
          <section role="dialog" aria-modal="true" aria-labelledby="staleDirectiveTitle" className="terminalDialogPanel w-full max-w-md border border-[#2fbffc] bg-[#050e18] p-6 shadow-[0_0_30px_#2fbffc33] phoneLandscape:max-w-2xl phoneLandscape:p-4">
            <p className="mb-2 text-xs tracking-[.2em] text-[#1c7ba6]">CHECK / STALE DIRECTIVE</p>
            <h2 id="staleDirectiveTitle" className="mb-3 text-2xl font-bold phoneLandscape:text-xl">이 지령을 계속 수행합니까?</h2>
            <p className="text-sm leading-6 text-[#567287]">{ticketStaleness.reason} 현재 상태를 임의로 변경하지 않았습니다.</p>
            <p className="mt-3 border-l border-[#165b80] pl-3 text-xs leading-5 text-[#31536a]">시간 경과 실패를 선택하면 이 지령을 이력에 남기고 현재 시각을 기준으로 즉시 다시 계획합니다.</p>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button type="button" className="outlineButton" disabled={isBusy} onClick={() => void handleStaleContinue(ticket.id)}>계속 수행</button>
              <button type="button" className="terminalButton" disabled={isBusy} onClick={() => void handleStaleReplan(ticket.id)}>실패 후 재계획</button>
            </div>
          </section>
        </div>
      )}

      {isFailOpen && ticket && (
        <div data-pin-terminal-navigation="true" className="terminalDialogOverlay fixed inset-0 z-30 flex items-end justify-center bg-black/75 sm:items-center phoneLandscape:items-start" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsFailOpen(false); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="failTitle" className="terminalDialogPanel w-full max-w-md border border-[#2fbffc] bg-[#050e18] p-6 shadow-[0_0_30px_#2fbffc33] phoneLandscape:max-w-2xl phoneLandscape:p-4">
            <p className="mb-2 text-xs tracking-[.2em] text-[#1c7ba6]">REPORT / FAILURE</p>
            <h2 id="failTitle" className="mb-2 text-2xl font-bold">실패 사유</h2>
            <p className="mb-5 text-sm leading-6 text-[#567287]">이유를 하나 선택해 주세요. 평가는 하지 않습니다.</p>
            <fieldset className="space-y-2 phoneLandscape:grid phoneLandscape:grid-cols-2 phoneLandscape:gap-2 phoneLandscape:space-y-0">
              <legend className="sr-only">실패 사유</legend>
              {failureReasons.map((reason) => (
                <label key={reason.value} className={`flex min-h-12 cursor-pointer items-center gap-3 border px-3 py-2 text-sm ${failureReason === reason.value ? "border-[#2fbffc] bg-[#072233] text-[#5cd0ff]" : "border-[#165b80]"}`}>
                  <input type="radio" name="failureReason" value={reason.value} checked={failureReason === reason.value} onChange={() => setFailureReason(reason.value)} className="accent-[#2fbffc]" />
                  {reason.label}
                </label>
              ))}
            </fieldset>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button className="outlineButton" disabled={isBusy} onClick={() => setIsFailOpen(false)}>돌아가기</button>
              <button className="terminalButton" disabled={isBusy} onClick={() => void handleFailureAndReissue(ticket.id)}>사유 기록</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
