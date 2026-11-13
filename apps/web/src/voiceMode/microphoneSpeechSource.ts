import {
  VoiceModeError,
  type SpeechSource,
  type SpeechSourceHandlers,
} from "./voiceModeController";

const DETECTOR_ASSETS = `${import.meta.env.BASE_URL}${import.meta.env.VITE_VOICE_MODE_DETECTOR_ASSETS}`;

// Silero v5 at 16 kHz. An utterance ends after `redemptionMs` of quiet, so that delay is part of
// every reply's latency; shorter than this cuts people off at a breath. A quick one-word answer
// ("two", "no") scores about 250 ms of speech, so `minSpeechMs` has to sit well below that.
const DETECTOR_OPTIONS = {
  model: "v5",
  positiveSpeechThreshold: 0.5,
  negativeSpeechThreshold: 0.35,
  minSpeechMs: 160,
  redemptionMs: 600,
  preSpeechPadMs: 300,
} as const;

function microphoneError(error: unknown): VoiceModeError {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new VoiceModeError({
      message:
        "Microphone access was denied. Allow it for T3 Code in System Settings → Privacy & Security → Microphone, then turn voice mode on again.",
      cause: error,
    });
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return new VoiceModeError({
      message:
        "The microphone chosen in Settings → Voice was not found. Connect it or choose another, then turn voice mode on again.",
      cause: error,
    });
  }
  return detectorError(error);
}

function detectorError(error: unknown): VoiceModeError {
  const detail = error instanceof Error ? error.message : String(error);
  return new VoiceModeError({
    message: `Speech detection could not start: ${detail}`,
    cause: error,
  });
}

/**
 * Listens to the microphone and cuts what it hears into utterances.
 *
 * Echo cancellation is on so the agent's spoken reply, played by this same app, is removed from
 * what the microphone picks up. That is what lets the user talk over a reply on speakers.
 */
export function createMicrophoneSpeechSource(
  handlers: SpeechSourceHandlers,
  options: { readonly microphoneId: string },
): SpeechSource {
  let detector: { destroy(): Promise<void> } | null = null;
  let stopped = false;

  const release = async () => {
    const current = detector;
    detector = null;
    await current?.destroy();
  };

  return {
    async start() {
      // The detector and its runtime are fetched here, so nothing loads until voice mode is used.
      const { MicVAD } = await import("@ricky0123/vad-web").catch((error: unknown) => {
        throw detectorError(error);
      });
      const microphone: { failure?: VoiceModeError } = {};
      try {
        detector = await MicVAD.new({
          ...DETECTOR_OPTIONS,
          baseAssetPath: DETECTOR_ASSETS,
          onnxWASMBasePath: DETECTOR_ASSETS,
          // One thread and no proxy worker run without cross-origin isolation, which the app lacks.
          ortConfig: (ort) => {
            ort.env.wasm.numThreads = 1;
            ort.env.wasm.proxy = false;
            ort.env.logLevel = "error";
          },
          getStream: async () => {
            try {
              const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                  ...(options.microphoneId ? { deviceId: { exact: options.microphoneId } } : {}),
                  channelCount: 1,
                  echoCancellation: true,
                  noiseSuppression: true,
                  autoGainControl: true,
                },
              });
              for (const track of stream.getAudioTracks()) {
                track.addEventListener(
                  "ended",
                  () =>
                    handlers.onError(
                      new VoiceModeError({
                        message:
                          "The microphone disconnected. Reconnect it and turn voice mode on again.",
                      }),
                    ),
                  { once: true },
                );
              }
              return stream;
            } catch (error) {
              microphone.failure = microphoneError(error);
              throw microphone.failure;
            }
          },
          onSpeechStart: handlers.onSpeechStart,
          onSpeechRealStart: handlers.onSpeechConfirmed,
          onVADMisfire: handlers.onSpeechCancel,
          onSpeechEnd: handlers.onUtterance,
        });
      } catch (error) {
        throw microphone.failure ?? detectorError(error);
      }
      // Stopped while the microphone was still opening.
      if (stopped) await release();
    },

    async stop() {
      stopped = true;
      await release();
    },
  };
}
