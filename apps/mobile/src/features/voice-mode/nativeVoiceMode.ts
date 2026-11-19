import type { VoiceModeChime } from "@t3tools/client-runtime/voice-mode";
import { requireOptionalNativeModule } from "expo";

export type NativeSpeechEvent =
  | { readonly type: "start" | "confirmed" | "cancel" }
  | { readonly type: "utterance"; readonly uri: string }
  | { readonly type: "error"; readonly message: string };

export type NativeVoiceEvent =
  | { readonly type: "start" | "done"; readonly id: string }
  /** The player broke and has stopped. */
  | { readonly type: "error"; readonly message: string };

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
  /** Opens the player that plays audio made elsewhere on the call's route. */
  preparePlayer(): void;
  /** Plays a 16-bit mono WAV file after the audio already given; reported like `say`. */
  play(id: string, wav: Uint8Array): void;
  /** Silences both the text-to-speech voice and the player. */
  stopSpeaking(): void;
  shutDownVoice(): void;
  deleteUtterance(uri: string): void;
  /** Queues a chime; call it before stopListening so the stop chime plays on the call's route. */
  playChime(chime: VoiceModeChime): void;
}

/** Null where the app was built without voice mode, such as on iOS. */
export const nativeVoiceMode = requireOptionalNativeModule<NativeVoiceMode>("T3VoiceMode");
