import type { KokoroRequest, KokoroResponse } from "./kokoroProtocol";
import { VoiceModeError, type VoiceModeSpeaker } from "./voiceModeController";

// How long after a sentence ends the microphone may still be hearing its echo.
const ECHO_TAIL_MS = 4_000;
// A gap before the first sentence so the audio device has started when it plays.
const START_DELAY_SECONDS = 0.03;

interface Sentence {
  readonly text: string;
  source: AudioBufferSourceNode | null;
}

/**
 * Speaks with the Kokoro model, synthesized on this device in a worker.
 *
 * Playback goes through Web Audio so the microphone's echo cancellation hears it as the app's
 * own output and removes it. Sentences are synthesized ahead and played back to back.
 */
export function createKokoroSpeaker(
  readVoice: () => { readonly voice: string; readonly speed: number },
): VoiceModeSpeaker {
  let worker: Worker | null = null;
  let context: AudioContext | null = null;
  let generation = 0;
  let nextId = 0;
  // Sentences asked for and not yet finished playing, in the order they will be heard.
  const sentences = new Map<number, Sentence>();
  let recent: Array<{ readonly text: string; readonly endedAt: number }> = [];
  let playhead = 0;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Workers do not accept a target origin
  const send = (request: KokoroRequest) => worker?.postMessage(request);

  const play = (response: Extract<KokoroResponse, { type: "audio" }>) => {
    const sentence = sentences.get(response.id);
    if (!context || !sentence || response.generation !== generation) return;
    const buffer = context.createBuffer(1, response.samples.length, response.sampleRate);
    buffer.copyToChannel(response.samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.addEventListener("ended", () => {
      if (sentence.source !== source) return;
      sentences.delete(response.id);
      recent.push({ text: sentence.text, endedAt: performance.now() });
      notify();
    });
    sentence.source = source;
    const startAt = Math.max(context.currentTime + START_DELAY_SECONDS, playhead);
    source.start(startAt);
    playhead = startAt + buffer.duration;
  };

  const silence = () => {
    generation += 1;
    send({ type: "forget", generation });
    for (const sentence of sentences.values()) {
      const source = sentence.source;
      // Cleared first so the "ended" this stop fires is not taken for the sentence finishing.
      sentence.source = null;
      source?.stop();
    }
    sentences.clear();
    playhead = 0;
  };

  return {
    prepare({ signal, onDownloadProgress, onFailure }) {
      return new Promise<void>((resolve, reject) => {
        signal.throwIfAborted();
        const created = new Worker(new URL("./kokoro.worker.ts", import.meta.url), {
          type: "module",
        });
        worker = created;
        context = new AudioContext();
        let ready = false;
        const fail = (message: string) => {
          const error = new VoiceModeError({ message });
          if (ready) onFailure(error);
          else reject(error);
        };
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        created.addEventListener("error", (event) =>
          fail(`The voice could not be loaded: ${event.message || "the speech worker crashed"}`),
        );
        created.addEventListener("message", (event: MessageEvent<KokoroResponse>) => {
          const response = event.data;
          switch (response.type) {
            case "downloading":
              onDownloadProgress(response.fraction);
              break;
            case "ready":
              ready = true;
              resolve();
              break;
            case "audio":
              play(response);
              break;
            case "failed":
              fail(
                ready
                  ? `The voice stopped working: ${response.message}`
                  : `The voice could not be loaded: ${response.message}`,
              );
          }
        });
        const load: KokoroRequest = {
          type: "load",
          runtimeAssets: new URL(
            `${import.meta.env.BASE_URL}${import.meta.env.VITE_VOICE_MODE_SYNTHESIZER_ASSETS}`,
            window.location.href,
          ).href,
          voice: readVoice().voice,
        };
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Workers do not accept a target origin
        created.postMessage(load);
      });
    },

    say(text) {
      const id = nextId++;
      sentences.set(id, { text, source: null });
      send({ type: "say", id, generation, text, ...readVoice() });
      notify();
    },

    pause() {
      void context?.suspend();
    },

    resume() {
      void context?.resume();
    },

    stop() {
      silence();
      void context?.resume();
      notify();
    },

    shutDown() {
      silence();
      recent = [];
      worker?.terminate();
      worker = null;
      void context?.close();
      context = null;
    },

    isActive: () => sentences.size > 0,

    recentText() {
      const cutoff = performance.now() - ECHO_TAIL_MS;
      recent = recent.filter((entry) => entry.endedAt >= cutoff);
      return [...recent, ...sentences.values()].map((entry) => entry.text).join(" ");
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
