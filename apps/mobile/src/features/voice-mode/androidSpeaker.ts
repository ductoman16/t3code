import { VoiceModeError, type VoiceModeSpeaker } from "@t3tools/client-runtime/voice-mode";

import type { NativeVoiceMode } from "./nativeVoiceMode";

interface Sentence {
  readonly id: string;
  readonly text: string;
}

/** How long a finished sentence may still come back through the microphone as an echo. */
const ECHO_MS = 2000;

export interface AndroidSpeaker extends VoiceModeSpeaker {
  /** The sentence being read aloud, or the last one read until speech is stopped. */
  caption(): string;
  subscribeCaption(listener: () => void): () => void;
}

/**
 * Says sentences with Android's text-to-speech. Android cannot pause speech, so a pause stops it
 * and a resume starts again from the sentence that was cut off.
 */
export function createAndroidSpeaker(
  native: Pick<
    NativeVoiceMode,
    "addListener" | "prepareVoice" | "say" | "stopSpeaking" | "shutDownVoice"
  >,
  readRate: () => number,
  now: () => number = Date.now,
): AndroidSpeaker {
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
  const speak = (sentence: Sentence) => native.say(sentence.id, sentence.text, readRate());
  const withNewId = (text: string): Sentence => ({ id: `s${nextId++}`, text });

  return {
    async prepare() {
      subscription ??= native.addListener("onVoice", (event) => {
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
        await native.prepareVoice();
      } catch (cause) {
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
      if (!paused) speak(sentence);
      if (!wasActive) notify();
    },
    pause() {
      if (paused) return;
      // Held even with nothing queued, so a reply that arrives while the user talks waits for them.
      paused = true;
      if (queue.length > 0) native.stopSpeaking();
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
      native.stopSpeaking();
      setCaption("");
      if (wasActive) notify();
    },
    shutDown() {
      queue = [];
      paused = false;
      setCaption("");
      subscription?.remove();
      subscription = null;
      native.shutDownVoice();
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
