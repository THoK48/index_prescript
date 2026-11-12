"use client";

import { useEffect } from "react";

const temporalInputTypes = new Set(["date", "datetime-local", "time", "month", "week"]);

/** Reports whether the currently focused control owns a browser-native date or time picker. */
function isTemporalInput(element: Element | null): element is HTMLInputElement {
  return element instanceof HTMLInputElement && temporalInputTypes.has(element.type);
}

/** Closes browser-native date and time pickers when interaction continues outside the active control. */
export function TemporalPickerDismissal() {
  useEffect(() => {
    /** Blurs only an active temporal input while preserving presses on that input or its wrapping label. */
    function dismissOnOutsidePointer(event: PointerEvent) {
      const activeElement = document.activeElement;
      if (!isTemporalInput(activeElement) || !(event.target instanceof Node)) return;
      if (event.target === activeElement || activeElement.contains(event.target)) return;
      if (event.target instanceof Element && event.target.closest("label")?.contains(activeElement)) return;
      activeElement.blur();
    }

    /** Provides the same close behavior for keyboard users without clearing the selected value. */
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && isTemporalInput(document.activeElement)) {
        document.activeElement.blur();
      }
    }

    document.addEventListener("pointerdown", dismissOnOutsidePointer, true);
    document.addEventListener("keydown", dismissOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOnOutsidePointer, true);
      document.removeEventListener("keydown", dismissOnEscape, true);
    };
  }, []);

  return null;
}
