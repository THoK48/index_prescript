import type { CapacitorConfig } from "@capacitor/cli";
import { notificationSoundFile } from "./src/lib/notificationSound";

const config: CapacitorConfig = {
  appId: "com.directive.terminal",
  appName: "지령 단말기",
  webDir: "out",
  backgroundColor: "#000000",
  plugins: {
    LocalNotifications: {
      sound: notificationSoundFile,
    },
  },
};

export default config;
