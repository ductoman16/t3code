import { VoiceModeError } from "@t3tools/client-runtime/voice-mode";

import type { SpeakerVoice } from "./androidSpeaker";
import type { NativeVoiceMode } from "./nativeVoiceMode";

/** Reads text aloud on an environment, as the desktop app does. */
export interface EnvironmentSynthesizer {
  prepare(signal: AbortSignal): Promise<void>;
  /** One sentence as a 16-bit mono WAV file. */
  speak(text: string, speed: number, signal: AbortSignal): Promise<Uint8Array>;
}

/**
 * Kokoro on an environment, played on the phone's call route. Sentences are synthesized one at a
 * time as soon as they are said, ahead of playback, so the next one is ready when the last ends.
 * Audio cut off by a pause is kept and played again on resume.
 */
export function environmentVoice(
  native: Pick<
    NativeVoiceMode,
    "addListener" | "preparePlayer" | "play" | "stopSpeaking" | "shutDownVoice"
  >,
  synthesizer: EnvironmentSynthesizer,
  readRate: () => number,
): SpeakerVoice {
  // Bumped by every silence; audio for an older generation is never handed to the player.
  let generation = 0;
  let requests = new AbortController();
  let synthesized = new Map<string, Promise<Uint8Array>>();
  let synthesizing: Promise<unknown> = Promise.resolve();
  let playing: Promise<void> = Promise.resolve();
  const textOf = new Map<string, string>();
  let failed: ((error: unknown) => void) | null = null;
  let subscription: { remove(): void } | null = null;

  const synthesize = (text: string) => {
    const existing = synthesized.get(text);
    if (existing) return existing;
    const { signal } = requests;
    const audio = synthesizing.then(() => {
      signal.throwIfAborted();
      return synthesizer.speak(text, readRate(), signal);
    });
    synthesizing = audio.catch(() => undefined);
    synthesized.set(text, audio);
    return audio;
  };

  const fail = (cause: unknown) => {
    const report = failed;
    failed = null;
    report?.(
      new VoiceModeError({
        message: `The voice stopped working: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
    );
  };

  const silence = () => {
    generation += 1;
    textOf.clear();
    native.stopSpeaking();
  };

  return {
    async prepare({ signal, onFailure }) {
      native.preparePlayer();
      await synthesizer.prepare(signal);
      failed = onFailure;
      // A sentence played to its end is not needed again.
      subscription ??= native.addListener("onVoice", (event) => {
        if (event.type === "error") fail(new Error(event.message));
        if (event.type !== "done") return;
        const text = textOf.get(event.id);
        textOf.delete(event.id);
        if (text !== undefined && ![...textOf.values()].includes(text)) synthesized.delete(text);
      });
    },
    say(id, text) {
      const audio = synthesize(text);
      const current = generation;
      textOf.set(id, text);
      playing = playing
        .then(() => audio)
        .then(
          (wav) => {
            if (current === generation) native.play(id, wav);
          },
          (cause: unknown) => {
            if (current === generation) fail(cause);
          },
        )
        .catch(fail);
    },
    expect(text) {
      void synthesize(text).catch(() => undefined);
    },
    interrupt: silence,
    clear() {
      silence();
      requests.abort();
      requests = new AbortController();
      synthesized = new Map();
      synthesizing = Promise.resolve();
      playing = Promise.resolve();
    },
    shutDown() {
      silence();
      requests.abort();
      requests = new AbortController();
      synthesized = new Map();
      failed = null;
      subscription?.remove();
      subscription = null;
      native.shutDownVoice();
    },
  };
}
