"use client";

import { useEffect, useRef, useState } from "react";
import { DecryptingText } from "@/components/DecryptingText";
import {
  getActiveTicket,
  getActiveTicketStaleness,
  type FailureReason,
  type InvalidDirectiveReason,
  type Ticket,
} from "@/lib/ticketMachine";
import { playTicketSignalUntilSettled, tryPlayTicketSignal } from "@/lib/ticketSignal";
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

/** Formats a deadline for the printed ticket card. */
function formatDeadline(value: string | null): string {
  if (!value) return "가능한 때에.";
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("ko-KR", {
    month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: false,
  }).format(date);
  return `${parts}까지.`;
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
  const { state, issue, completeAndReissue, failAndReissue, invalidateAndReissue } = useLocalState();
  const [failureReason, setFailureReason] = useState<FailureReason>("time_shortage");
  const [isFailOpen, setIsFailOpen] = useState(false);
  const [isReasonOpen, setIsReasonOpen] = useState(false);
  const [invalidTicketId, setInvalidTicketId] = useState<string | null>(null);
  const [invalidReason, setInvalidReason] = useState<InvalidDirectiveReason>("TIME_IMPOSSIBLE");
  const [invalidError, setInvalidError] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [currentTime, setCurrentTime] = useState(() => new Date());
  const [dismissedStaleTicketId, setDismissedStaleTicketId] = useState<string | null>(null);
  const hasStartedEntrySignalRef = useRef(false);
  const ticket = state ? getActiveTicket(state) : null;
  const lastTicket = state?.tickets[0];
  const todayExecutionCounts = getTodayExecutionCounts(state?.tickets ?? [], currentTime);
  const ticketStaleness = ticket ? getActiveTicketStaleness(ticket, currentTime) : null;
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
      const soundPromise = playTicketSignalUntilSettled(actionPromise);
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
      const issuePromise = issue();
      const soundPromise = playTicketSignalUntilSettled(issuePromise);
      const [, success] = await Promise.all([soundPromise, issuePromise]);
      setMessage(success ? "새 지령이 발행되었습니다." : "현재 지령 상태가 변경되었습니다. 화면을 확인해 주세요.");
    } catch {
      setMessage("상태를 저장하지 못했습니다. 다시 시도해 주세요.");
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

  /** Opens quality feedback for the current ticket identity without resolving it yet. */
  function openInvalidFeedback(ticketId: string) {
    setInvalidReason("TIME_IMPOSSIBLE");
    setInvalidError("");
    setIsFailOpen(false);
    setInvalidTicketId(ticketId);
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
      {ticket && (
        <div className="absolute inset-x-0 top-0 mx-auto flex w-full max-w-2xl items-center justify-between gap-4 px-1 text-[10px] tracking-[.12em] text-[#1c7ba6] sm:px-4 phoneLandscape:static phoneLandscape:mb-3 phoneLandscape:max-w-4xl phoneLandscape:px-0">
          <span><DecryptingText text={`수행 완료: ${todayExecutionCounts.completed}`} delayMs={60} /></span>
          <span><DecryptingText text={`수행 실패: ${todayExecutionCounts.failed}`} delayMs={90} /></span>
        </div>
      )}
      <div className="w-full min-w-0 max-w-2xl phoneLandscape:grid phoneLandscape:max-w-4xl phoneLandscape:grid-cols-[minmax(0,1fr)_8rem] phoneLandscape:items-start phoneLandscape:gap-6">
        {ticket ? (
          <>
            <article key={ticket.id} className="directivePanel relative min-w-0 px-1 py-8 [overflow-wrap:anywhere] sm:px-4 sm:py-10 phoneLandscape:px-0 phoneLandscape:py-1" aria-label="현재 지령">
              <p className="mb-8 text-base font-bold sm:text-lg phoneLandscape:mb-4 phoneLandscape:text-base">
                <DecryptingText text={`[${ticket.recipient}에게]`} delayMs={120} />
              </p>
              <div className="space-y-5 text-xl font-semibold leading-[1.7] tracking-tight sm:space-y-6 sm:text-3xl phoneLandscape:space-y-3 phoneLandscape:text-xl phoneLandscape:leading-relaxed">
                <p><DecryptingText text={formatDeadline(ticket.deadline)} delayMs={180} /></p>
                <p><DecryptingText text={ticket.trigger} delayMs={240} /></p>
                <p className="font-extrabold">
                  <DecryptingText text={ticket.action} delayMs={300} />
                </p>
              </div>
              <div className="mt-12 flex items-center gap-2 text-[11px] tracking-[.12em] text-[#1c7ba6] phoneLandscape:mt-5">
                <span><DecryptingText text={`발행 ${new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ticket.createdAt))}`} delayMs={420} /></span>
                <button
                  type="button"
                  aria-label="선택 근거 보기"
                  aria-expanded={isReasonOpen}
                  className="group flex h-5 w-5 items-center justify-center text-[#183447] opacity-45 transition-colors hover:text-[#5cd0ff] hover:opacity-100 focus-visible:text-[#5cd0ff]"
                  onClick={() => setIsReasonOpen((current) => !current)}
                >
                  <span className="flex h-3 w-3 items-center justify-center rounded-full border border-[#0d2839] text-[7px] font-bold lowercase leading-none group-hover:border-[#1c7ba6] group-focus-visible:border-[#2fbffc]"><DecryptingText text="i" delayMs={450} /></span>
                </button>
              </div>
              {isReasonOpen && (
                <div className="mt-2 border-l border-[#165b80] pl-2 text-[10px] tracking-[.1em] text-[#31536a]">
                  <p role="status"><DecryptingText text={`선택 근거 / ${formatSelectionReason(ticket)}`} delayMs={40} /></p>
                  <p className="mt-3"><DecryptingText text="이 지령이 적절하지 않나요?" delayMs={80} /></p>
                  <button type="button" disabled={isBusy} className="mt-1 min-h-9 text-left text-[#567287] underline decoration-[#165b80] underline-offset-4 hover:text-[#5cd0ff]" onClick={() => openInvalidFeedback(ticket.id)}><DecryptingText text="이상 지령으로 기록" delayMs={100} /></button>
                </div>
              )}
            </article>
            <div className="mt-5 grid grid-cols-2 gap-3 phoneLandscape:mt-4 phoneLandscape:grid-cols-1">
              <button className="terminalButton" disabled={isBusy} onClick={() => handleReissue(() => completeAndReissue(ticket.id), "완료가 기록되고 다음 지령이 재발급되었습니다.")}>완료</button>
              <button className="outlineButton" disabled={isBusy} onClick={() => setIsFailOpen(true)}>실패</button>
            </div>
          </>
        ) : (
          <section className="border border-[#165b80] bg-[#050e18] px-6 py-10 text-center shadow-[0_0_24px_#2fbffc17] sm:px-12 sm:py-14 phoneLandscape:col-span-2 phoneLandscape:px-6 phoneLandscape:py-5">
            <div className="mx-auto mb-7 flex h-16 w-16 items-center justify-center border border-[#2fbffc] text-3xl text-[#5cd0ff] shadow-[0_0_14px_#2fbffc33] phoneLandscape:mb-3 phoneLandscape:h-10 phoneLandscape:w-10 phoneLandscape:text-xl" aria-hidden="true">⌁</div>
            <p className="mb-3 text-xs tracking-[.22em] text-[#1c7ba6]">NO ACTIVE DIRECTIVE</p>
            <h1 className="mb-4 text-3xl font-bold sm:text-4xl phoneLandscape:mb-2 phoneLandscape:text-2xl">현재 지령 없음</h1>
            <p className="mx-auto mb-9 max-w-sm text-sm leading-7 text-[#567287] phoneLandscape:mb-4 phoneLandscape:max-w-xl phoneLandscape:leading-5">
              {lastTicket ? "이전 지령이 처리되었습니다. 준비되면 다음 지령을 발행하세요." : "준비되면 첫 지령을 발행하세요. 한 번에 하나의 행동만 표시됩니다."}
            </p>
            <button className="terminalButton w-full max-w-xs" disabled={isBusy} onClick={handleIssue}>지령 발행</button>
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
              <button type="button" className="outlineButton" disabled={isBusy} onClick={() => setDismissedStaleTicketId(ticket.id)}>계속 수행</button>
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
              <button className="terminalButton" disabled={isBusy} onClick={() => handleReissue(() => failAndReissue(ticket.id, failureReason), "실패 사유가 기록되고 다음 지령이 재발급되었습니다.")}>사유 기록</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
