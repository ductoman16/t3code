import type { VoiceModeState } from "@t3tools/client-runtime/voice-mode";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

/** What the call screen's circle shows. */
export type CallLook =
  | "connecting"
  | "listening"
  | "hearing"
  | "transcribing"
  | "sending"
  | "thinking"
  | "speaking";

/** `turnRunning`: the thread's agent is working on a reply that has not started to be read. */
export function callLook(state: VoiceModeState, turnRunning: boolean): CallLook {
  if (state.power !== "on") return "connecting";
  switch (state.activity) {
    case "hearing":
    case "transcribing":
    case "sending":
    case "speaking":
      return state.activity;
    case "listening":
      return turnRunning ? "thinking" : "listening";
  }
}

const LABELS = {
  connecting: msg("Connecting"),
  listening: msg("Listening"),
  hearing: msg("Hearing you"),
  transcribing: msg("Transcribing"),
  sending: msg("Sending"),
  thinking: msg("Thinking"),
  speaking: msg("Speaking"),
} satisfies Record<CallLook, string>;

export function callStatusLabel(
  state: VoiceModeState,
  look: CallLook,
  resolve: MessageResolver = m,
): string {
  if (look === "connecting" && state.downloading !== null) {
    return resolve(msg("Downloading {percent}%", { percent: Math.round(state.downloading * 100) }));
  }
  return resolve(LABELS[look]);
}
