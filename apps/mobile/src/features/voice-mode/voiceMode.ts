import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createReplyReader,
  VoiceModeController,
  VoiceModeError,
  type VoiceModeState,
  watchVoiceModeChimes,
} from "@t3tools/client-runtime/voice-mode";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { msg } from "gt-react-native";
import { useEffect, useEffectEvent, useSyncExternalStore } from "react";
import { getRecordingPermissionsAsync } from "expo-audio";
import * as Notifications from "expo-notifications";
import { AppRegistry, AppState } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { voiceModeReadingSpeed } from "../../persistence/mobile-preferences";
import { appAtomRegistry } from "../../state/atom-registry";
import { getComposerDraftSnapshot, setComposerDraftText } from "../../state/use-composer-drafts";
import { mobilePreferencesAtom } from "../../state/preferences";
import { environmentThreadDetails } from "../../state/threads";
import { createVoiceRecordingPermission } from "../voice-input/voiceRecordingPermission";
import { voiceRouteAtom } from "../voice-input/voiceDestination";
import { androidVoice, createAndroidSpeaker } from "./androidSpeaker";
import { environmentVoice } from "./environmentVoice";
import { createAndroidSpeechSource } from "./androidSpeechSource";
import { nativeVoiceMode } from "./nativeVoiceMode";
import { createRouteTranscriber } from "./routeTranscriber";
import { createVoiceModeCall } from "./voiceModeCall";

const SEND_AFTER_SILENCE_MS = 900;

function createVoiceMode() {
  const native = nativeVoiceMode;
  if (!native) return null;
  const readRate = () => {
    const preferences = appAtomRegistry.get(mobilePreferencesAtom);
    return voiceModeReadingSpeed(
      AsyncResult.isSuccess(preferences) ? preferences.value : undefined,
    );
  };
  // Replies are read where speech is transcribed: on the phone, or with Kokoro on the environment.
  const speaker = createAndroidSpeaker(native, () => {
    const route = appAtomRegistry.get(voiceRouteAtom);
    if (route === null) return androidVoice(native, readRate);
    if (route.synthesizer === "unsupported")
      throw new VoiceModeError({
        message:
          "The environment chosen in Settings → Voice cannot read replies aloud. Update T3 Code there.",
      });
    if (route.synthesizer === "disconnected")
      throw new VoiceModeError({
        message: "The environment chosen in Settings → Voice is not connected.",
      });
    return environmentVoice(native, route.synthesizer, readRate);
  });
  let askingForMicrophone = false;
  // Keeps the stored transcription choice loaded, so the first phrase uses it.
  appAtomRegistry.mount(voiceRouteAtom);
  appAtomRegistry.mount(mobilePreferencesAtom);
  const controller = new VoiceModeController<string>({
    createSpeechSource: createAndroidSpeechSource(native, async () => {
      const current = await getRecordingPermissionsAsync();
      if (current.granted) return current;
      // Android's permission dialog sends the app to the background for a moment.
      askingForMicrophone = true;
      const permission = createVoiceRecordingPermission(() => {});
      try {
        return await permission.requestPermission();
      } finally {
        permission.dispose();
        askingForMicrophone = false;
      }
    }),
    transcriber: createRouteTranscriber({
      resolve: async () => {
        const route = appAtomRegistry.get(voiceRouteAtom);
        return route === null ? getLocalVoiceTranscriber() : route.transcriber;
      },
      unavailableMessage: () =>
        appAtomRegistry.get(voiceRouteAtom) === null
          ? "This phone cannot transcribe on its own. Choose an environment in Settings → Voice."
          : "The environment chosen for transcription in Settings → Voice is not connected.",
      discard: (uri) => native.deleteUtterance(uri),
    }),
    speaker,
    schedule: (delayMs, run) => {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    },
    settings: () => ({ sendAfterSilenceMs: SEND_AFTER_SILENCE_MS }),
  });

  // Chimes from a state listener, which runs before the controller closes the microphone.
  watchVoiceModeChimes(controller, (chime) => native.playChime(chime));

  let reported: VoiceModeState["error"] = null;
  controller.subscribe(() => {
    const { error } = controller.state;
    if (error && error !== reported) Dialog.alert(m(msg("Voice mode stopped")), error);
    reported = error;
  });
  const call = createVoiceModeCall({
    native,
    controller,
    askingForMicrophone: () => askingForMicrophone,
    askForNotifications: async () => {
      const current = await Notifications.getPermissionsAsync();
      if (!current.granted && current.canAskAgain) await Notifications.requestPermissionsAsync();
    },
  });
  AppState.addEventListener("change", call.appStateChanged);
  // Keeps JavaScript timers running with the screen off; the native module ends it with the call.
  AppRegistry.registerHeadlessTask("T3VoiceMode", () => () => new Promise<void>(() => {}));
  return { controller, speaker };
}

const created = createVoiceMode();
/** One voice mode for the app: it follows the thread on screen. Null without the native module. */
const voiceMode = created?.controller ?? null;

export const voiceModeAvailable = voiceMode !== null;

const OFF_STATE: VoiceModeState = {
  power: "off",
  activity: "listening",
  downloading: null,
  error: null,
  notice: null,
  sent: 0,
};

export function useVoiceModeState(): VoiceModeState {
  return useSyncExternalStore(
    voiceMode?.subscribe ?? (() => () => {}),
    () => voiceMode?.state ?? OFF_STATE,
  );
}

/** The agent's sentence being read aloud, or the last one read; "" when there is none. */
export function useVoiceModeCaption(): string {
  return useSyncExternalStore(
    created?.speaker.subscribeCaption ?? (() => () => {}),
    () => created?.speaker.caption() ?? "",
  );
}

export function turnOnVoiceMode(): void {
  void voiceMode?.turnOn();
}

export function turnOffVoiceMode(): void {
  voiceMode?.turnOff();
}

/**
 * The text a message to `threadKey` should carry, with a note for the thread's model when voice
 * mode has come on or gone off since it last heard. Call `sent` once the message is on its way.
 */
export function noteVoiceModeMessage(threadKey: string, text: string) {
  return voiceMode?.noteMessage(threadKey, text) ?? { text, sent: () => {} };
}

/** Makes this thread the one voice mode talks to while its screen is open. */
export function useVoiceModeThread(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly submit: () => void;
  readonly isTurnRunning: () => boolean;
  readonly interrupt: () => void;
}): void {
  const { environmentId, threadId } = input;
  const submit = useEffectEvent(input.submit);
  const isTurnRunning = useEffectEvent(input.isTurnRunning);
  const interrupt = useEffectEvent(input.interrupt);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the open thread with the app-wide voice mode for as long as it is on screen
  useEffect(() => {
    if (!voiceMode || !environmentId || !threadId) return;
    const threadKey = scopedThreadKey(environmentId, threadId);
    const thread = scopeThreadRef(environmentId, threadId);
    return voiceMode.registerTarget({
      key: threadKey,
      thread: threadKey,
      readDraft: () => getComposerDraftSnapshot(threadKey).text,
      commitDraft: (text) => {
        setComposerDraftText(threadKey, text);
        return true;
      },
      submit: () => {
        submit();
        return true;
      },
      isTurnRunning: () => isTurnRunning(),
      interrupt: () => interrupt(),
      watchReplies: (handlers, options) => {
        const reader = createReplyReader(handlers, options);
        return appAtomRegistry.subscribe(
          environmentThreadDetails.visibleTurnItemsAtom(thread),
          (items) => reader.read(items),
          { immediate: true },
        );
      },
    });
  }, [environmentId, threadId]);
}
