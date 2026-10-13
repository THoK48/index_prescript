"use client";

import { useState } from "react";
import { getInvalidDirectiveHistory, invalidDirectiveReasonLabels, invalidDirectiveReasons } from "@/lib/directiveFeedback";
import type { InvalidDirectiveReason, Ticket } from "@/lib/ticketMachine";

/** Formats a quality-report timestamp in the device's local time. */
function formatFeedbackTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "시각 미상";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

/** Exposes quality cases and their original decisions separately from user completion and failure records. */
export function InvalidDirectiveHistory({ tickets }: { tickets: Ticket[] }) {
  const [reasonFilter, setReasonFilter] = useState<InvalidDirectiveReason | "ALL">("ALL");
  const [message, setMessage] = useState("");
  const records = getInvalidDirectiveHistory(tickets);
  const visibleRecords = reasonFilter === "ALL" ? records : records.filter((ticket) => ticket.invalidReason === reasonFilter);

  /** Copies quality records including durable original-decision snapshots for later Planner review. */
  async function copyFeedback() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(records, null, 2));
      setMessage("이상 지령 기록을 복사했습니다.");
    } catch {
      setMessage("기록을 복사하지 못했습니다. 브라우저 권한을 확인해 주세요.");
    }
  }

  return (
    <section className="mt-6 min-w-0 border border-[#165b80] bg-[#050e18] p-5 text-[#5cd0ff] sm:p-6 phoneLandscape:p-4" aria-label="이상 지령 기록">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#165b80] pb-4">
        <div>
          <h2 className="text-sm font-bold">이상 지령 기록 · {records.length}건</h2>
          <p className="mt-2 text-xs leading-5 text-[#567287]">사용자 실패와 별도로 모은 Planner 판단 사례입니다.</p>
        </div>
        <button type="button" className="outlineButton text-xs" disabled={records.length === 0} onClick={() => void copyFeedback()}>기록 JSON 복사</button>
      </div>
      {message && <p role="status" className="mt-3 text-xs text-[#1c7ba6]">{message}</p>}
      {records.length === 0 ? (
        <p className="py-8 text-center text-sm text-[#31536a]">아직 기록된 이상 지령이 없습니다.</p>
      ) : (
        <>
          <label className="mt-4 block max-w-md text-xs text-[#567287]">
            사유별 보기
            <select className="terminalField mt-2" value={reasonFilter} onChange={(event) => {
              const value = event.target.value;
              const reason = invalidDirectiveReasons.find((item) => item === value);
              setReasonFilter(reason ?? "ALL");
            }}>
              <option value="ALL">전체 · {records.length}건</option>
              {invalidDirectiveReasons.map((reason) => (
                <option key={reason} value={reason}>{invalidDirectiveReasonLabels[reason]} · {records.filter((ticket) => ticket.invalidReason === reason).length}건</option>
              ))}
            </select>
          </label>
          <div className="mt-4 max-h-[36rem] space-y-3 overflow-y-auto pr-1">
            {visibleRecords.length === 0 && <p className="py-6 text-center text-xs text-[#31536a]">이 사유로 기록된 지령이 없습니다.</p>}
            {visibleRecords.map((ticket) => (
              <details key={ticket.id} className="border border-[#0d3850] bg-[#071320] open:border-[#1c7ba6]">
                <summary className="cursor-pointer px-4 py-3">
                  <span className="break-words text-sm font-bold">{ticket.action}</span>
                  <span className="mt-2 flex flex-wrap justify-between gap-2 text-[11px] text-[#567287]">
                    <span>{invalidDirectiveReasonLabels[ticket.invalidReason ?? "OTHER"]}</span>
                    <time>{formatFeedbackTime(ticket.invalidatedAt ?? ticket.createdAt)}</time>
                  </span>
                </summary>
                <div className="border-t border-[#0d3850] px-4 py-3 text-xs leading-6 text-[#567287]">
                  <p>발행 시각 · {formatFeedbackTime(ticket.createdAt)}</p>
                  <p className="break-all">원본 항목 · {ticket.sourceType} / {ticket.sourceId ?? "미지정"}</p>
                  <p className="break-words">발행 근거 · {ticket.selectionReason ?? "이전 버전 지령으로 근거 기록 없음"}</p>
                  {ticket.invalidDecision && (
                    <>
                      <p>발행 당시 가용시간 · {ticket.invalidDecision.availableMinutes}분</p>
                      <ul className="mt-3 space-y-2 border-t border-[#0d3850] pt-3">
                        {ticket.invalidDecision.candidates.map((candidate, index) => (
                          <li key={`${candidate.sourceType}-${candidate.sourceId ?? index}`} className="break-words">
                            <span className="text-[#8edfff]">{candidate.label}</span> · {candidate.reason}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              </details>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
