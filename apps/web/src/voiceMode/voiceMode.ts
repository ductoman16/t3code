import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";

import { toastManager } from "../components/ui/toast";
import { getClientSettings } from "../hooks/useSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useVoiceTranscriptionDestination } from "../speech/useEnvironmentSpeechInput";
import { environmentThreadDetails } from "../state/threads";
import {
  createEnvironmentTranscriber,
  type TranscriptionDestination,
} from "./environmentTranscriber";
import { createKokoroSpeaker } from "./kokoroSpeaker";
import { createMicrophoneSpeechSource } from "./microphoneSpeechSource";
import { createReplyReader } from "./replyReader";
import {
  VoiceModeController,
  type VoiceModeState,
  type VoiceModeTarget,
} from "./voiceModeController";
import { readVoiceModeSettings } from "./voiceModeSettings";

// Resolved by a hook, so the composer publishes it here for the controller to read.
let transcriptionDestination: TranscriptionDestination | null = null;

/** One voice mode for the whole window: it follows whichever composer is on screen. */
const voiceMode = new VoiceModeController({
  createSpeechSource: (handlers) =>
    createMicrophoneSpeechSource(handlers, { microphoneId: getClientSettings().voiceMicrophone }),
  transcriber: createEnvironmentTranscriber(() => transcriptionDestination),
  speaker: createKokoroSpeaker(readVoiceModeSettings),
  schedule: (delayMs, run) => {
    const timer = setTimeout(run, delayMs);
    return () => clearTimeout(timer);
  },
  settings: readVoiceModeSettings,
});

let reported: Pick<VoiceModeState, "error" | "notice"> = { error: null, notice: null };
voiceMode.subscribe(() => {
  const { error, notice } = voiceMode.state;
  if (error && error !== reported.error) {
    toastManager.add({ type: "error", title: "Voice mode stopped", description: error });
  }
  if (notice && notice !== reported.notice) {
    toastManager.add({ type: "warning", title: "Voice mode", description: notice });
  }
  reported = { error, notice };
});

export function toggleVoiceMode(): void {
  voiceMode.toggle();
}

/**
 * Sends a composer's draft through `send`, with a note for the thread's model when voice mode
 * has come on or gone off since it last heard. Every send from a composer goes through here.
 */
export function sendWithVoiceModeNote(
  draft: {
    readonly thread: ScopedThreadRef;
    readonly read: () => string;
    readonly replace: (text: string) => boolean;
  },
  send: () => boolean,
): boolean {
  return voiceMode.sendDraft({ ...draft, thread: scopedThreadKey(draft.thread) }, send);
}

export function useVoiceModeState(): VoiceModeState {
  return useSyncExternalStore(voiceMode.subscribe, () => voiceMode.state);
}

/** Keeps voice mode's transcription on the destination chosen in Settings → Voice. */
export function useVoiceModeTranscription(): void {
  const destination = useVoiceTranscriptionDestination();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the hook-resolved destination to the window-wide controller
  useEffect(() => {
    transcriptionDestination = destination;
  });
}

function watchThreadReplies(
  thread: ScopedThreadRef,
  ...[handlers, options]: Parameters<VoiceModeTarget["watchReplies"]>
): () => void {
  const reader = createReplyReader(handlers, options);
  return appAtomRegistry.subscribe(
    environmentThreadDetails.visibleTurnItemsAtom(thread),
    (items) => reader.read(items),
    { immediate: true },
  );
}

/**
 * Makes this composer the one voice mode talks to while it is mounted.
 * Pass callbacks that stay the same between renders.
 */
export function useVoiceModeComposer(input: {
  readonly draftKey: string;
  /** Null until the draft's first message has created its thread. */
  readonly thread: ScopedThreadRef | null;
  readonly enabled: boolean;
  readonly readDraft: () => string;
  readonly commitDraft: (text: string) => boolean;
  readonly submit: () => boolean;
  readonly isTurnRunning: () => boolean;
  readonly interrupt: () => void;
}): void {
  const { draftKey, enabled, readDraft, commitDraft, submit, isTurnRunning, interrupt } = input;
  // The ref is a new object on every render; its two ids are what identify the thread.
  const environmentId = input.thread?.environmentId ?? null;
  const threadId = input.thread?.threadId ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this composer with the window-wide voice mode for as long as it is on screen
  useEffect(() => {
    if (!enabled) return;
    const thread = environmentId && threadId ? scopeThreadRef(environmentId, threadId) : null;
    return voiceMode.registerTarget({
      // A draft becomes a different conversation once its thread exists and replies can arrive.
      key: thread ? `${draftKey}@${scopedThreadKey(thread)}` : draftKey,
      readDraft,
      commitDraft,
      submit,
      isTurnRunning,
      interrupt,
      watchReplies: (handlers, options) =>
        thread ? watchThreadReplies(thread, handlers, options) : () => {},
    });
  }, [
    draftKey,
    environmentId,
    threadId,
    enabled,
    readDraft,
    commitDraft,
    submit,
    isTurnRunning,
    interrupt,
  ]);
}
