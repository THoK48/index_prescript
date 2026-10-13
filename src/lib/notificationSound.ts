import type { Channel } from "@capacitor/local-notifications";

/** User WAV bundled in Android res/raw and iOS Copy Bundle Resources; Android requires lowercase resource names. */
export const notificationSoundFile = "directive_alert.wav";

/** A new channel ID applies the requested audio on existing installs without deleting their old channel. */
export const notificationChannelId = "directive-alerts-custom-v1";

/** Defines Android notification audio; bump the channel ID if the bundled sound changes in a later release. */
export function createAndroidNotificationChannel(): Channel {
  return {
    id: notificationChannelId,
    name: "지령 및 루틴",
    description: "지령 종료 예상 시각과 루틴 시작을 지정된 비프음으로 알립니다.",
    importance: 4,
    visibility: 1,
    vibration: true,
    sound: notificationSoundFile,
  };
}

/** Sets the same bundled WAV for iOS and legacy Android notifications; ordinary web calls stay unchanged. */
export function getNotificationSoundOptions(platform: string): { sound?: string } {
  return platform === "android" || platform === "ios" ? { sound: notificationSoundFile } : {};
}
