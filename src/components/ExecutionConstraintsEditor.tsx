"use client";

import {
  actionCapabilityLabels, normalizeExecutionConstraints, userActivityLabels,
  type ActionCapability, type ExecutionConstraints, type UserActivity,
} from "@/lib/userContext";

interface ExecutionConstraintsEditorProps {
  value?: ExecutionConstraints;
  onChange: (value: ExecutionConstraints | undefined) => void;
  disabled?: boolean;
}

/** Edits explicit action requirements shared by Task, routine, detailed step, and System fallback forms. */
export function ExecutionConstraintsEditor({ value, onChange, disabled = false }: ExecutionConstraintsEditorProps) {
  /** Changes one requirement while preserving the source's other explicit restrictions. */
  function update(change: Partial<ExecutionConstraints>) {
    onChange(normalizeExecutionConstraints({ ...value, ...change }));
  }

  return (
    <details className="min-w-0 border border-[#0d3850] text-[#567287]">
      <summary className="cursor-pointer px-3 py-2 text-xs">수행 조건 / 선택 사항</summary>
      <fieldset disabled={disabled} className="space-y-3 border-t border-[#0d3850] p-3 text-xs disabled:opacity-45">
        <p className="text-[10px] leading-5">설정한 조건만 Planner가 확인합니다. 미지정은 제한 없음이며 분류로 추측하지 않습니다.</p>
        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(actionCapabilityLabels) as ActionCapability[]).map((capability) => (
            <label key={capability} className="flex items-center gap-2">
              <input type="checkbox" className="accent-[#2fbffc]" checked={value?.requiredCapabilities?.includes(capability) ?? false}
                onChange={(event) => update({ requiredCapabilities: event.target.checked
                  ? [...(value?.requiredCapabilities ?? []), capability] : value?.requiredCapabilities?.filter((item) => item !== capability) })} />
              {actionCapabilityLabels[capability]} 필요
            </label>
          ))}
        </div>
        <p className="text-[10px]">다음 활동 중에는 수행하지 않음</p>
        <div className="flex flex-wrap gap-3">
          {(["OVERTIME", "OUTSIDE"] as UserActivity[]).map((activity) => (
            <label key={activity} className="flex items-center gap-2">
              <input type="checkbox" className="accent-[#2fbffc]" checked={value?.blockedActivities?.includes(activity) ?? false}
                onChange={(event) => update({ blockedActivities: event.target.checked
                  ? [...(value?.blockedActivities ?? []), activity] : value?.blockedActivities?.filter((item) => item !== activity) })} />
              {userActivityLabels[activity]}
            </label>
          ))}
        </div>
        <label className="block">수행 강도
          <select className="terminalField mt-2" value={value?.effort ?? ""}
            onChange={(event) => update({ effort: event.target.value === "HIGH" ? "HIGH" : event.target.value === "NORMAL" ? "NORMAL" : event.target.value === "LIGHT" ? "LIGHT" : undefined })}>
            <option value="">미지정</option><option value="LIGHT">가벼움</option><option value="NORMAL">보통</option><option value="HIGH">높음</option>
          </select>
        </label>
      </fieldset>
    </details>
  );
}
