export interface TicketSignalTone {
  startOffsetSeconds: number;
  durationSeconds: number;
  frequencyHz: number;
  endFrequencyHz: number;
  waveform: OscillatorType;
  peakGain: number;
}

export interface TicketPrintPlan {
  durationSeconds: number;
  pulseOffsetsSeconds: number[];
}

export const ticketSignalAssetPath = "/audio/limbus-beep.wav";
export const ticketWaitLoopAssetPath = "/audio/limbus-beep-wait-loop.wav";

type OpeningSignalPlayer = () => Promise<void>;
type WaitLoopPlayer = (untilSettled: Promise<void>) => Promise<void>;

/** Returns the three-tone terminal signal as testable timing data. */
export function createTicketSignalPlan(): TicketSignalTone[] {
  const toneDurationSeconds = 0.2;
  const silenceSeconds = 0.7;
  const intervalSeconds = toneDurationSeconds + silenceSeconds;
  return [0, intervalSeconds, intervalSeconds * 2].map((startOffsetSeconds) => ({
    startOffsetSeconds,
    durationSeconds: toneDurationSeconds,
    frequencyHz: 880,
    endFrequencyHz: 440,
    waveform: "square",
    peakGain: 0.085,
  }));
}

/** Returns the timing plan for a short mechanical ticket-printer effect. */
export function createTicketPrintPlan(): TicketPrintPlan {
  return {
    durationSeconds: 0.9,
    pulseOffsetsSeconds: Array.from({ length: 11 }, (_, index) => index * 0.075),
  };
}

/** Plays the bundled reference recording and reports whether playback completed. */
async function playReferenceTicketSignal(): Promise<boolean> {
  if (typeof window === "undefined" || !window.Audio) return false;

  const audio = new window.Audio(ticketSignalAssetPath);
  audio.preload = "auto";
  audio.volume = 0.8;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let safetyTimer = 0;
    /** Resolves once and stops incomplete playback before the synthesized fallback begins. */
    function settle(didComplete: boolean) {
      if (settled) return;
      settled = true;
      window.clearTimeout(safetyTimer);
      if (!didComplete) audio.pause();
      resolve(didComplete);
    }
    audio.addEventListener("ended", () => settle(true), { once: true });
    audio.addEventListener("error", () => settle(false), { once: true });
    safetyTimer = window.setTimeout(() => settle(false), 3_500);
    audio.play().catch(() => settle(false));
  });
}

/** Plays the Limbus-inspired synthesized fallback and reports whether audio could start. */
async function playFallbackTicketSignal(): Promise<boolean> {
  if (!window.AudioContext) return false;

  let audioContext: AudioContext | null = null;
  try {
    audioContext = new window.AudioContext();
    await audioContext.resume();
    if (audioContext.state !== "running") return false;
    const signalPlan = createTicketSignalPlan();
    const baseTime = audioContext.currentTime + 0.02;

    for (const tone of signalPlan) {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const startTime = baseTime + tone.startOffsetSeconds;
      const endTime = startTime + tone.durationSeconds;

      oscillator.type = tone.waveform;
      oscillator.frequency.setValueAtTime(tone.frequencyHz, startTime);
      oscillator.frequency.exponentialRampToValueAtTime(tone.endFrequencyHz, startTime + 0.15);
      gain.gain.setValueAtTime(0.0001, startTime);
      gain.gain.linearRampToValueAtTime(tone.peakGain, startTime + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, endTime);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(startTime);
      oscillator.stop(endTime);
    }

    const lastTone = signalPlan.at(-1);
    const sequenceSeconds = lastTone
      ? lastTone.startOffsetSeconds + lastTone.durationSeconds + 0.05
      : 0;
    await new Promise<void>((resolve) => window.setTimeout(resolve, sequenceSeconds * 1_000));
    return true;
  } catch {
    // Audio is decorative; unsupported or blocked playback must not prevent issuing a ticket.
    return false;
  } finally {
    if (audioContext && audioContext.state !== "closed") {
      await audioContext.close().catch(() => undefined);
    }
  }
}

/** Tries the bundled reference sound, then its synthesized fallback, and reports audible playback. */
export async function tryPlayTicketSignal(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (await playReferenceTicketSignal()) return true;
  return playFallbackTicketSignal();
}

/** Plays the bundled Limbus reference sound, falling back to synthesized terminal beeps. */
export async function playTicketSignal(): Promise<void> {
  await tryPlayTicketSignal();
}

/** Repeats the supplied wait clip until a delayed ticket transition settles. */
async function playReferenceWaitLoop(untilSettled: Promise<void>): Promise<void> {
  if (typeof window === "undefined" || !window.Audio) {
    await untilSettled;
    return;
  }

  const audio = new window.Audio(ticketWaitLoopAssetPath);
  audio.preload = "auto";
  audio.loop = true;
  audio.volume = 0.8;
  try {
    await audio.play();
    await untilSettled;
  } catch {
    await untilSettled;
  } finally {
    audio.pause();
    audio.currentTime = 0;
  }
}

/** Coordinates an opening signal and starts a wait loop only when an operation remains pending. */
export async function coordinateTicketSignal(
  operation: Promise<unknown>,
  playOpening: OpeningSignalPlayer,
  playWaitLoop: WaitLoopPlayer,
): Promise<void> {
  let isPending = true;
  const untilSettled = operation.then(
    () => { isPending = false; },
    () => { isPending = false; },
  );

  await playOpening();
  if (isPending) await playWaitLoop(untilSettled);
  await untilSettled;
}

/** Plays the opening sound and loops the supplied wait clip only for a delayed ticket transition. */
export async function playTicketSignalUntilSettled(operation: Promise<unknown>): Promise<void> {
  await coordinateTicketSignal(operation, playTicketSignal, playReferenceWaitLoop);
}

/** Synthesizes a filtered motor-and-paper sound while the issued ticket appears. */
export async function playTicketPrintSound(): Promise<void> {
  if (typeof window === "undefined" || !window.AudioContext) return;

  let audioContext: AudioContext | null = null;
  try {
    audioContext = new window.AudioContext();
    await audioContext.resume();
    const printPlan = createTicketPrintPlan();
    const startTime = audioContext.currentTime + 0.01;
    const endTime = startTime + printPlan.durationSeconds;

    const noiseBuffer = audioContext.createBuffer(
      1,
      Math.ceil(audioContext.sampleRate * printPlan.durationSeconds),
      audioContext.sampleRate,
    );
    const noiseData = noiseBuffer.getChannelData(0);
    for (let index = 0; index < noiseData.length; index += 1) {
      noiseData[index] = (Math.random() * 2 - 1) * 0.32;
    }

    const paperNoise = audioContext.createBufferSource();
    const highPass = audioContext.createBiquadFilter();
    const lowPass = audioContext.createBiquadFilter();
    const paperGain = audioContext.createGain();
    paperNoise.buffer = noiseBuffer;
    highPass.type = "highpass";
    highPass.frequency.setValueAtTime(480, startTime);
    lowPass.type = "lowpass";
    lowPass.frequency.setValueAtTime(3_200, startTime);
    paperGain.gain.setValueAtTime(0.0001, startTime);

    for (const pulseOffset of printPlan.pulseOffsetsSeconds) {
      const pulseStart = startTime + pulseOffset;
      paperGain.gain.setValueAtTime(0.0001, pulseStart);
      paperGain.gain.linearRampToValueAtTime(0.075, pulseStart + 0.008);
      paperGain.gain.setValueAtTime(0.045, pulseStart + 0.045);
      paperGain.gain.exponentialRampToValueAtTime(0.0001, pulseStart + 0.065);
    }

    const motor = audioContext.createOscillator();
    const motorGain = audioContext.createGain();
    motor.type = "sawtooth";
    motor.frequency.setValueAtTime(135, startTime);
    motor.frequency.linearRampToValueAtTime(165, endTime);
    motorGain.gain.setValueAtTime(0.0001, startTime);
    motorGain.gain.linearRampToValueAtTime(0.018, startTime + 0.04);
    motorGain.gain.setValueAtTime(0.018, endTime - 0.08);
    motorGain.gain.exponentialRampToValueAtTime(0.0001, endTime);

    paperNoise.connect(highPass);
    highPass.connect(lowPass);
    lowPass.connect(paperGain);
    paperGain.connect(audioContext.destination);
    motor.connect(motorGain);
    motorGain.connect(audioContext.destination);
    paperNoise.start(startTime);
    paperNoise.stop(endTime);
    motor.start(startTime);
    motor.stop(endTime);

    await new Promise<void>((resolve) => window.setTimeout(resolve, (printPlan.durationSeconds + 0.04) * 1_000));
  } catch {
    // The printer effect is decorative and must never block the state transition.
  } finally {
    if (audioContext && audioContext.state !== "closed") {
      await audioContext.close().catch(() => undefined);
    }
  }
}
