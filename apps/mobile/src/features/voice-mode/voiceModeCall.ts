import type { VoiceModeController } from "@t3tools/client-runtime/voice-mode";
import type { AppStateStatus } from "react-native";

import type { NativeVoiceMode } from "./nativeVoiceMode";

/**
 * Voice mode on Android runs like a phone call: a foreground service keeps it going with the
 * screen off, its notification can hang it up, and the app asks once to show that notification.
 */
export function createVoiceModeCall(input: {
  readonly native: Pick<NativeVoiceMode, "addListener">;
  readonly controller: Pick<VoiceModeController<string>, "state" | "subscribe" | "turnOff">;
  readonly askingForMicrophone: () => boolean;
  readonly askForNotifications: () => Promise<void>;
}) {
  const { controller } = input;
  input.native.addListener("onHangUp", () => controller.turnOff());
  let askedForNotifications = false;
  controller.subscribe(() => {
    if (controller.state.power !== "on" || askedForNotifications) return;
    askedForNotifications = true;
    void input.askForNotifications();
  });
  return {
    appStateChanged(state: AppStateStatus) {
      // The call's service can only start while the app is on screen; once it runs, it keeps going.
      if (
        state === "background" &&
        controller.state.power === "starting" &&
        !input.askingForMicrophone()
      ) {
        controller.turnOff();
      }
    },
  };
}
