import type { Metadata, Viewport } from "next";
import "./globals.css";
import { LocalStateProvider } from "@/lib/localState";
import { TerminalNavigation } from "@/components/TerminalNavigation";
import { CalendarWidgetNavigation } from "@/components/CalendarWidgetNavigation";

export const metadata: Metadata = {
  title: "지령 단말기",
  description: "지금 실행할 행동 하나를 보여주는 개인 일정 플래너",
};

/** Allows responsive layouts to use the full mobile viewport while CSS protects notch and gesture areas. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/** Wraps routes in a scrolling, safe-area-aware mobile shell with persistent local state. */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>
        <LocalStateProvider>
          <CalendarWidgetNavigation />
          <div className="terminalShell mx-auto flex min-h-dvh w-full max-w-6xl flex-col">
            <TerminalNavigation />
            <main className="flex min-w-0 flex-1 flex-col">{children}</main>
          </div>
        </LocalStateProvider>
      </body>
    </html>
  );
}
