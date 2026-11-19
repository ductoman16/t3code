import { VoiceModeError, type VoiceModeSpeaker } from "@t3tools/client-runtime/voice-mode";

import type { NativeVoiceMode } from "./nativeVoiceMode";

interface Sentence {
  readonly id: string;
  readonly text: string;
}

/** How long a finished sentence may still come back through the microphone as an echo. */
const ECHO_MS = 2000;

/**
 * What turns sentences into sound. It reports each sentence's start and end as the native module's
 * onVoice events, under the id it was given.
 */
export interface SpeakerVoice {
  prepare(options: {
    readonly signal: AbortSignal;
    readonly onFailure: (error: unknown) => void;
  }): Promise<void>;
  /** Says a sentence after the ones already said. */
  say(id: string, text: string): void;
  /** A sentence that will be said after a pause; a voice may get it ready meanwhile. */
  expect(text: string): void;
  /** Silences speech now; what was cut off is said again under new ids. */
  interrupt(): void;
  /** Silences speech and forgets everything given to it. */
  clear(): void;
  shutDown(): void;
}

export interface AndroidSpeaker extends VoiceModeSpeaker {
  /** The sentence being read aloud, or the last one read until speech is stopped. */
  caption(): string;
  subscribeCaption(listener: () => void): () => void;
}

/** Android's own text-to-speech, read on the call's audio route. */
export function androidVoice(
  native: Pick<NativeVoiceMode, "prepareVoice" | "say" | "stopSpeaking" | "shutDownVoice">,
  readRate: () => number,
): SpeakerVoice {
  return {
    async prepare() {
      await native.prepareVoice();
    },
    say: (id, text) => native.say(id, text, readRate()),
    expect: () => {},
    interrupt: () => native.stopSpeaking(),
    clear: () => native.stopSpeaking(),
    shutDown: () => native.shutDownVoice(),
  };
}

/**
 * Says sentences with the voice chosen when voice mode comes on. A pause silences the voice and a
 * resume starts again from the sentence that was cut off.
 */
export function createAndroidSpeaker(
  native: Pick<NativeVoiceMode, "addListener">,
  chooseVoice: () => SpeakerVoice,
  now: () => number = Date.now,
): AndroidSpeaker {
  let voice: SpeakerVoice | null = null;
  let queue: Sentence[] = [];
  let paused = false;
  let nextId = 0;
  let spoken: { text: string; until: number } | null = null;
  let subscription: { remove(): void } | null = null;
  const listeners = new Set<() => void>();
  let caption = "";
  const captionListeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };
  const setCaption = (text: string) => {
    if (text === caption) return;
    caption = text;
    for (const listener of captionListeners) listener();
  };
  const speak = (sentence: Sentence) => voice?.say(sentence.id, sentence.text);
  const withNewId = (text: string): Sentence => ({ id: `s${nextId++}`, text });

  return {
    async prepare({ signal, onFailure }) {
      subscription ??= native.addListener("onVoice", (event) => {
        if (event.type === "error") return;
        const index = queue.findIndex((sentence) => sentence.id === event.id);
        if (index === -1) return;
        const sentence = queue[index]!;
        if (event.type === "start") {
          spoken = { text: sentence.text, until: Number.POSITIVE_INFINITY };
          setCaption(sentence.text);
          return;
        }
        // A sentence stopped by a pause is said again on resume.
        if (paused) return;
        queue = queue.filter((_, position) => position !== index);
        spoken = { text: sentence.text, until: now() + ECHO_MS };
        if (queue.length === 0) notify();
      });
      try {
        const chosen = chooseVoice();
        voice = chosen;
        await chosen.prepare({ signal, onFailure });
      } catch (cause) {
        voice = null;
        throw new VoiceModeError({
          message: cause instanceof Error ? cause.message : "The voice could not be loaded.",
          cause,
        });
      }
    },
    say(text) {
      const sentence = withNewId(text);
      const wasActive = queue.length > 0;
      queue = [...queue, sentence];
      if (paused) voice?.expect(text);
      else speak(sentence);
      if (!wasActive) notify();
    },
    pause() {
      if (paused) return;
      // Held even with nothing queued, so a reply that arrives while the user talks waits for them.
      paused = true;
      if (queue.length > 0) voice?.interrupt();
    },
    resume() {
      if (!paused) return;
      paused = false;
      // Fresh ids, so the stop that ended the old ones cannot end these.
      queue = queue.map((sentence) => withNewId(sentence.text));
      queue.forEach(speak);
    },
    stop() {
      const wasActive = queue.length > 0;
      queue = [];
      paused = false;
      voice?.clear();
      setCaption("");
      if (wasActive) notify();
    },
    shutDown() {
      queue = [];
      paused = false;
      setCaption("");
      subscription?.remove();
      subscription = null;
      voice?.shutDown();
      voice = null;
    },
    isActive: () => queue.length > 0,
    recentText: () => (spoken && spoken.until > now() ? spoken.text : ""),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    caption: () => caption,
    subscribeCaption(listener) {
      captionListeners.add(listener);
      return () => captionListeners.delete(listener);
    },
  };
}
