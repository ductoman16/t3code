import {
  VoiceModeError,
  type SpeechSource,
  type SpeechSourceHandlers,
} from "@t3tools/client-runtime/voice-mode";

import type { NativeVoiceMode } from "./nativeVoiceMode";

const NO_MICROPHONE =
  "Voice mode needs the microphone. Allow it for T3 Code in Android's settings.";

/** The phone's microphone, reporting each utterance as a WAV file on the device. */
export function createAndroidSpeechSource(
  native: Pick<NativeVoiceMode, "addListener" | "startListening" | "stopListening">,
  requestPermission: () => Promise<{ readonly granted: boolean }>,
) {
  return (handlers: SpeechSourceHandlers<string>): SpeechSource => {
    let subscription: { remove(): void } | null = null;
    return {
      async start() {
        if (!(await requestPermission()).granted)
          throw new VoiceModeError({ message: NO_MICROPHONE });
        const listening = native.addListener("onSpeech", (event) => {
          switch (event.type) {
            case "start":
              return handlers.onSpeechStart();
            case "confirmed":
              return handlers.onSpeechConfirmed();
            case "cancel":
              return handlers.onSpeechCancel();
            case "utterance":
              return handlers.onUtterance(event.uri);
            case "error":
              return handlers.onError(new VoiceModeError({ message: event.message }));
          }
        });
        subscription = listening;
        try {
          await native.startListening();
        } catch (cause) {
          listening.remove();
          subscription = null;
          throw new VoiceModeError({
            message: cause instanceof Error ? cause.message : "The microphone could not be opened.",
            cause,
          });
        }
      },
      async stop() {
        subscription?.remove();
        subscription = null;
        await native.stopListening();
      },
    };
  };
}
