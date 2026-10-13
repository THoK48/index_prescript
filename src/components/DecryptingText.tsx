"use client";

import { useEffect, useState } from "react";
import { createDecryptionFrame } from "@/lib/decryption";

interface DecryptingTextProps {
  text: string;
  delayMs?: number;
}

/** Sets a slightly slower cadence so each decrypted character remains legible. */
const decryptionStepMs = 44;

/** Reveals a directive sentence from terminal glyphs while keeping the original text accessible. */
export function DecryptingText({ text, delayMs = 0 }: DecryptingTextProps) {
  const [displayText, setDisplayText] = useState(text);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDisplayText(text);
      setIsVisible(true);
      return undefined;
    }

    let timer: number | undefined;
    const delayTimer = window.setTimeout(() => {
      let revealedCharacters = 0;
      setDisplayText(createDecryptionFrame(text, revealedCharacters));
      setIsVisible(true);

      timer = window.setInterval(() => {
        revealedCharacters += 1;
        if (revealedCharacters >= Array.from(text).length) {
          setDisplayText(text);
          window.clearInterval(timer);
          return;
        }
        setDisplayText(createDecryptionFrame(text, revealedCharacters));
      }, decryptionStepMs);
    }, delayMs);

    return () => {
      window.clearTimeout(delayTimer);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [delayMs, text]);

  return (
    <span className={`transition-opacity duration-75 ${isVisible ? "opacity-100" : "opacity-0"}`}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">{displayText}</span>
    </span>
  );
}
