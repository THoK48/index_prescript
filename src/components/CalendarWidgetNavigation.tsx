"use client";

import { useEffect, useState } from "react";
import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { calendarWidgetBridge } from "@/lib/calendarWidgetBridge";
import { createCalendarWidgetUrl, parseCalendarWidgetLaunch } from "@/lib/calendarWidget";

/** Receives cold/warm Android widget taps and opens the existing calendar editor once. */
export function CalendarWidgetNavigation() {
  const [error, setError] = useState("");

  useEffect(() => {
    if (Capacitor.getPlatform() !== "android") return;
    let disposed = false;
    let listener: PluginListenerHandle | undefined;
    const handledRequests = new Set<string>();

    /** Acknowledges only a validated request, then forwards it through a fixed app route. */
    async function openCalendar(value: unknown) {
      const request = parseCalendarWidgetLaunch(value);
      if (disposed || !request || handledRequests.has(request.requestId)) return;
      handledRequests.add(request.requestId);
      try {
        const result = await calendarWidgetBridge.acknowledgeLaunch({ requestId: request.requestId });
        if (!disposed && result.acknowledged) window.location.assign(createCalendarWidgetUrl(request));
      } catch {
        handledRequests.delete(request.requestId);
        if (!disposed) setError("위젯 등록창을 열지 못했습니다. 위젯을 다시 눌러주세요.");
      }
    }

    /** Installs the warm-launch listener before retrieving any pending cold-start request. */
    async function connectWidget() {
      try {
        const handle = await calendarWidgetBridge.addListener("calendarLaunch", (request) => { void openCalendar(request); });
        if (disposed) { await handle.remove(); return; }
        listener = handle;
        const pending = await calendarWidgetBridge.getLaunchRequest();
        if (!disposed) await openCalendar(pending.request);
      } catch {
        if (!disposed) setError("캘린더 위젯 연결을 시작하지 못했습니다. 앱을 다시 열어주세요.");
      }
    }

    void connectWidget();
    return () => {
      disposed = true;
      void listener?.remove().catch(() => { console.warn("Calendar widget listener cleanup failed."); });
    };
  }, []);

  return error ? <p role="alert" className="mx-5 mt-3 border border-[#165b80] p-3 text-xs text-[#8edfff]">{error}</p> : null;
}
