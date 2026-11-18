import type { VoiceModeChime } from "@t3tools/client-runtime/voice-mode";
import { requireOptionalNativeModule } from "expo";

export type NativeSpeechEvent =
  | { readonly type: "start" | "confirmed" | "cancel" }
  | { readonly type: "utterance"; readonly uri: string }
  | { readonly type: "error"; readonly message: string };

export interface NativeVoiceEvent {
  readonly type: "start" | "done";
  readonly id: string;
}

/** The Android module in modules/t3-voice-mode. */
interface Subscription {
  remove(): void;
}

export interface NativeVoiceMode {
  addListener(event: "onSpeech", listener: (event: NativeSpeechEvent) => void): Subscription;
  addListener(event: "onVoice", listener: (event: NativeVoiceEvent) => void): Subscription;
  /** The Hang up action on voice mode's notification. */
  addListener(event: "onHangUp", listener: () => void): Subscription;
  startListening(): Promise<void>;
  stopListening(): Promise<void>;
  prepareVoice(): Promise<void>;
  say(id: string, text: string, rate: number): void;
  stopSpeaking(): void;
  shutDownVoice(): void;
  deleteUtterance(uri: string): void;
  /** Queues a chime; call it before stopListening so the stop chime plays on the call's route. */
  playChime(chime: VoiceModeChime): void;
}

/** Null where the app was built without voice mode, such as on iOS. */
export const nativeVoiceMode = requireOptionalNativeModule<NativeVoiceMode>("T3VoiceMode");
