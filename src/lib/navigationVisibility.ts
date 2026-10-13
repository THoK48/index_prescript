export const navigationIdleMs = 5_000;
export const navigationRevealWindowMs = 1_400;
export const navigationRevealClickCount = 3;

export interface NavigationRevealSequence {
  clickCount: number;
  lastClickedAt: number | null;
}

export interface NavigationRevealResult {
  sequence: NavigationRevealSequence;
  shouldReveal: boolean;
}

/** Creates an empty background-click sequence for the navigation reveal gesture. */
export function createNavigationRevealSequence(): NavigationRevealSequence {
  return { clickCount: 0, lastClickedAt: null };
}

/** Advances the reveal gesture and reports when three timely background clicks complete it. */
export function advanceNavigationRevealSequence(
  sequence: NavigationRevealSequence,
  clickedAt: number,
): NavigationRevealResult {
  const isWithinWindow = sequence.lastClickedAt !== null
    && clickedAt - sequence.lastClickedAt <= navigationRevealWindowMs;
  const clickCount = isWithinWindow ? sequence.clickCount + 1 : 1;

  if (clickCount < navigationRevealClickCount) {
    return {
      sequence: { clickCount, lastClickedAt: clickedAt },
      shouldReveal: false,
    };
  }

  return {
    sequence: createNavigationRevealSequence(),
    shouldReveal: true,
  };
}
