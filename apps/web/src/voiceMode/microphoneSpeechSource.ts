import type { MicVAD } from "@ricky0123/vad-web";
import {
  isVoiceModeError,
  VoiceModeError,
  type SpeechSource,
  type SpeechSourceHandlers,
} from "@t3tools/client-runtime/voice-mode";

import { recordingDeviceId, shouldSwitchMicrophone, type OpenMicrophone } from "./microphoneSwitch";

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

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

interface Microphone extends OpenMicrophone {
  readonly stream: MediaStream;
  readonly track: MediaStreamTrack | undefined;
}

/**
 * Listens to the microphone and cuts what it hears into utterances. The detector hears one steady
 * stream that the microphone is plugged into, so when devices change mid-call the call moves to
 * whatever Settings → Voice's order now picks without interrupting the detector or the phrase.
 * Echo cancellation lets the user talk over a reply played on speakers.
 */
export function createMicrophoneSpeechSource(
  handlers: SpeechSourceHandlers,
  options: {
    /** The device id to record from, empty for the system default. */
    readonly chooseMicrophone: () => Promise<string>;
  },
): SpeechSource {
  let stopped = false;
  let detector: MicVAD | null = null;
  let context: AudioContext | null = null;
  let mixer: MediaStreamAudioDestinationNode | null = null;
  let current: (Microphone & { readonly node: MediaStreamAudioSourceNode }) | null = null;
  let switching = false;
  let switchAgain = false;

  /** Opens the chosen microphone; one that opens after hang-up is closed again at once. */
  const openMicrophone = async (): Promise<Microphone | null> => {
    const microphoneId = recordingDeviceId(await options.chooseMicrophone());
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(microphoneId ? { deviceId: { exact: microphoneId } } : {}),
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (stopped) {
      stopTracks(stream);
      return null;
    }
    const [track] = stream.getAudioTracks();
    return { microphoneId, groupId: track?.getSettings().groupId ?? "", stream, track };
  };

  /** Plugs a microphone in, then lets go of the one it replaces. One hung up on is closed instead. */
  const plugIn = (microphone: Microphone) => {
    if (stopped || !context || !mixer) {
      stopTracks(microphone.stream);
      return;
    }
    let node: MediaStreamAudioSourceNode;
    try {
      node = new MediaStreamAudioSourceNode(context, { mediaStream: microphone.stream });
      node.connect(mixer);
    } catch (error) {
      stopTracks(microphone.stream);
      throw error;
    }
    const previous = current;
    current = { ...microphone, node };
    // A track ends when its device goes away; stopping it ourselves does not fire this.
    microphone.track?.addEventListener("ended", followDevices, { once: true });
    if (previous) {
      previous.node.disconnect();
      stopTracks(previous.stream);
    }
  };

  const switchIfNeeded = async () => {
    const was = current;
    if (!was || stopped) return;
    const [microphoneId, devices] = await Promise.all([
      options.chooseMicrophone(),
      navigator.mediaDevices.enumerateDevices(),
    ]);
    const gone = was.track?.readyState === "ended";
    if (!gone && !shouldSwitchMicrophone(was, recordingDeviceId(microphoneId), devices)) return;
    let next: Microphone | null;
    try {
      next = await openMicrophone();
    } catch (error) {
      // The old microphone still works, or another device change is already queued to retry.
      if (!gone || switchAgain) return;
      // The replacement vanished too; the order may now pick one that is still there.
      next = await openMicrophone().catch(() => {
        throw error;
      });
    }
    if (next) plugIn(next);
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
    const [vad, audio, microphone] = [detector, context, current];
    detector = null;
    context = null;
    mixer = null;
    current = null;
    if (microphone) {
      microphone.node.disconnect();
      stopTracks(microphone.stream);
    }
    await vad?.destroy();
    await audio?.close();
  };

  return {
    async start() {
      // The detector and its runtime are fetched here, so nothing loads until voice mode is used.
      const { MicVAD } = await import("@ricky0123/vad-web").catch((error: unknown) => {
        throw detectorError(error);
      });
      context = new AudioContext();
      mixer = context.createMediaStreamDestination();
      const steady = mixer.stream;
      // The detector loads before the microphone opens, so hanging up during a slow load never
      // leaves the microphone on.
      try {
        detector = await MicVAD.new({
          ...DETECTOR_OPTIONS,
          audioContext: context,
          baseAssetPath: DETECTOR_ASSETS,
          onnxWASMBasePath: DETECTOR_ASSETS,
          // One thread and no proxy worker run without cross-origin isolation, which the app lacks.
          ortConfig: (ort) => {
            ort.env.wasm.numThreads = 1;
            ort.env.wasm.proxy = false;
            ort.env.logLevel = "error";
          },
          // The steady stream outlives every microphone; the source opens and closes those itself.
          getStream: async () => steady,
          pauseStream: async () => {},
          resumeStream: async () => steady,
          onSpeechStart: handlers.onSpeechStart,
          onSpeechRealStart: handlers.onSpeechConfirmed,
          onVADMisfire: handlers.onSpeechCancel,
          onSpeechEnd: handlers.onUtterance,
        });
      } catch (error) {
        await release();
        throw detectorError(error);
      }
      // Stopped while the detector was still loading.
      if (stopped) {
        await release();
        return;
      }
      try {
        const first = await openMicrophone();
        if (first) plugIn(first);
      } catch (error) {
        await release();
        throw microphoneError(error);
      }
      if (stopped) return;
      navigator.mediaDevices.addEventListener("devicechange", followDevices);
      // The microphone may have changed while the detector loaded.
      followDevices();
    },

    async stop() {
      stopped = true;
      await release();
    },
  };
}
