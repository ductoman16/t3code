import type { MicVAD } from "@ricky0123/vad-web";
import {
  isVoiceModeError,
  VoiceModeError,
  type SpeechSource,
  type SpeechSourceHandlers,
} from "@t3tools/client-runtime/voice-mode";

import { shouldSwitchMicrophone, type OpenMicrophone } from "./microphoneSwitch";

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
  // A switch of microphone mid-phrase sends what was heard so far rather than dropping it.
  submitUserSpeechOnPause: true,
} as const;

function microphoneError(error: unknown): VoiceModeError {
  if (isVoiceModeError(error)) return error;
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
        "No microphone was found. Connect one or choose another in Settings → Voice, then turn voice mode on again.",
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
 * Listens to the microphone and cuts what it hears into utterances. When devices change mid-call,
 * the call moves to whatever microphone Settings → Voice's order now picks, a new system default
 * included; the browser keeps recording from the device it first opened otherwise. Echo
 * cancellation lets the user talk over a reply played on speakers.
 */
export function createMicrophoneSpeechSource(
  handlers: SpeechSourceHandlers,
  options: {
    /** The device id to record from, empty for the system default. */
    readonly chooseMicrophone: () => Promise<string>;
  },
): SpeechSource {
  let detector: MicVAD | null = null;
  let open: (OpenMicrophone & { readonly track: MediaStreamTrack | undefined }) | null = null;
  let stopped = false;
  let switching = false;
  let switchAgain = false;

  const openStream = async (): Promise<MediaStream> => {
    try {
      const microphoneId = await options.chooseMicrophone();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(microphoneId ? { deviceId: { exact: microphoneId } } : {}),
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const [track] = stream.getAudioTracks();
      open = { microphoneId, groupId: track?.getSettings().groupId ?? "", track };
      // A track ends when its device goes away; stopping it ourselves does not fire this.
      track?.addEventListener("ended", followDevices, { once: true });
      return stream;
    } catch (error) {
      throw microphoneError(error);
    }
  };

  const switchIfNeeded = async () => {
    const current = detector;
    const was = open;
    if (!current || !was || stopped) return;
    const [microphoneId, devices] = await Promise.all([
      options.chooseMicrophone(),
      navigator.mediaDevices.enumerateDevices(),
    ]);
    const gone = was.track?.readyState === "ended";
    if (!gone && !shouldSwitchMicrophone(was, microphoneId, devices)) return;
    // Pausing ends the phrase in progress and stops the old stream; starting opens the new one.
    await current.pause();
    if (!stopped) await current.start();
  };

  // Device events arrive in bursts, so switches run one at a time and a burst ends in one recheck.
  function followDevices() {
    if (stopped) return;
    if (switching) {
      switchAgain = true;
      return;
    }
    switching = true;
    void (async () => {
      try {
        do {
          switchAgain = false;
          await switchIfNeeded();
        } while (switchAgain);
      } catch (error) {
        if (!stopped) handlers.onError(microphoneError(error));
      } finally {
        switching = false;
      }
    })();
  }

  const release = async () => {
    navigator.mediaDevices.removeEventListener("devicechange", followDevices);
    const current = detector;
    detector = null;
    open = null;
    // Hanging up drops a phrase in progress instead of sending it.
    current?.setOptions({ submitUserSpeechOnPause: false });
    await current?.destroy();
  };

  return {
    async start() {
      // The detector and its runtime are fetched here, so nothing loads until voice mode is used.
      const { MicVAD } = await import("@ricky0123/vad-web").catch((error: unknown) => {
        throw detectorError(error);
      });
      const microphone: { failure?: VoiceModeError } = {};
      const recordingStream = async () => {
        try {
          return await openStream();
        } catch (error) {
          microphone.failure = microphoneError(error);
          throw microphone.failure;
        }
      };
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
          getStream: recordingStream,
          resumeStream: openStream,
          onSpeechStart: handlers.onSpeechStart,
          onSpeechRealStart: handlers.onSpeechConfirmed,
          onVADMisfire: handlers.onSpeechCancel,
          onSpeechEnd: handlers.onUtterance,
        });
      } catch (error) {
        throw microphone.failure ?? detectorError(error);
      }
      // Stopped while the microphone was still opening.
      if (stopped) {
        await release();
        return;
      }
      navigator.mediaDevices.addEventListener("devicechange", followDevices);
    },

    async stop() {
      stopped = true;
      await release();
    },
  };
}
