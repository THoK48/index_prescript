"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  advanceNavigationRevealSequence,
  createNavigationRevealSequence,
  navigationIdleMs,
} from "@/lib/navigationVisibility";

const navigation = [
  { href: "/", label: "지령" },
  { href: "/tasks", label: "할 일" },
  { href: "/schedule", label: "루틴" },
  { href: "/settings", label: "설정" },
];

const ignoredRevealTargetSelector = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  "[role='button']",
  "[role='dialog']",
  "[contenteditable='true']",
  "[data-terminal-navigation]",
].join(",");

/** Renders a safe-area-aware dock with gesture reveal, route pinning, and five-second idle hiding. */
export function TerminalNavigation() {
  const pathname = usePathname();
  const [isVisible, setIsVisible] = useState(false);
  const [isDialogPinned, setIsDialogPinned] = useState(false);
  const isNavigationPinned = pathname !== "/" || isDialogPinned;
  const navigationRef = useRef<HTMLElement>(null);
  const hideTimeoutRef = useRef<number | null>(null);
  const revealSequenceRef = useRef(createNavigationRevealSequence());

  /** Cancels the current inactivity countdown while the navigation is being manipulated. */
  const clearHideTimer = useCallback(() => {
    if (hideTimeoutRef.current !== null) {
      window.clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  }, []);

  /** Hides the dock and releases focus from links that are no longer available. */
  const hideNavigation = useCallback(() => {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && navigationRef.current?.contains(activeElement)) {
      activeElement.blur();
    }
    setIsVisible(false);
  }, []);

  /** Restarts the five-second inactivity countdown after a navigation interaction. */
  const scheduleHide = useCallback(() => {
    clearHideTimer();
    if (isNavigationPinned) return;
    hideTimeoutRef.current = window.setTimeout(hideNavigation, navigationIdleMs);
  }, [clearHideTimer, hideNavigation, isNavigationPinned]);

  useEffect(() => {
    /** Counts only non-interactive surface clicks toward the reveal gesture. */
    function handleBackgroundClick(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Element) || target.closest(ignoredRevealTargetSelector)) {
        revealSequenceRef.current = createNavigationRevealSequence();
        return;
      }

      const result = advanceNavigationRevealSequence(revealSequenceRef.current, Date.now());
      revealSequenceRef.current = result.sequence;
      if (result.shouldReveal) {
        setIsVisible(true);
        scheduleHide();
      }
    }

    document.addEventListener("click", handleBackgroundClick);
    return () => document.removeEventListener("click", handleBackgroundClick);
  }, [scheduleHide]);

  useEffect(() => {
    /** Tracks whether a task or routine editor currently requires the dock above it. */
    function syncPinnedDialog() {
      const shouldPin = document.querySelector("[data-pin-terminal-navigation='true']") !== null;
      setIsDialogPinned(shouldPin);
    }

    const observer = new MutationObserver(syncPinnedDialog);
    observer.observe(document.body, { childList: true, subtree: true });
    syncPinnedDialog();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (isNavigationPinned) {
      clearHideTimer();
      setIsVisible(true);
      return;
    }
    scheduleHide();
  }, [clearHideTimer, isNavigationPinned, scheduleHide]);

  useEffect(() => clearHideTimer, [clearHideTimer]);

  return (
    <nav
      ref={navigationRef}
      aria-label="주 메뉴"
      aria-hidden={!isVisible}
      data-terminal-navigation
      onPointerEnter={scheduleHide}
      onPointerMove={scheduleHide}
      onPointerDown={clearHideTimer}
      onPointerUp={scheduleHide}
      onPointerCancel={scheduleHide}
      onFocusCapture={scheduleHide}
      onKeyDown={scheduleHide}
      onWheel={scheduleHide}
      onClick={scheduleHide}
      className={`terminalNavigation fixed bottom-0 left-1/2 grid w-full max-w-md -translate-x-1/2 grid-cols-4 border border-b-0 border-[#165b80] bg-[#020508]/95 px-2 py-2 backdrop-blur-sm transition-[transform,opacity] duration-200 motion-reduce:transition-none ${isNavigationPinned ? "z-40" : "z-20"} ${isVisible ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-full opacity-0"}`}
    >
      {navigation.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={pathname === item.href ? "page" : undefined}
          tabIndex={isVisible ? undefined : -1}
          className={`min-h-11 px-3 py-3 text-center text-sm transition-colors ${pathname === item.href ? "bg-[#2fbffc] font-bold text-black shadow-[0_0_10px_#2fbffc55]" : "text-[#1c7ba6] hover:bg-[#072233] hover:text-[#5cd0ff]"}`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
