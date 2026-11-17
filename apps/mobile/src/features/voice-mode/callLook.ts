import type { VoiceModeState } from "@t3tools/client-runtime/voice-mode";

/** What the call screen's circle shows. */
export type CallLook = "connecting" | "listening" | "hearing" | "thinking" | "speaking";

/** `turnRunning`: the thread's agent is working on a reply that has not started to be read. */
export function callLook(state: VoiceModeState, turnRunning: boolean): CallLook {
  if (state.power !== "on") return "connecting";
  switch (state.activity) {
    case "hearing":
    case "speaking":
      return state.activity;
    case "transcribing":
    case "sending":
      return "thinking";
    case "listening":
      return turnRunning ? "thinking" : "listening";
  }
}

const LABELS = {
  connecting: "Connecting",
  listening: "Listening",
  hearing: "Hearing you",
  thinking: "Thinking",
  speaking: "Speaking",
} as const satisfies Record<CallLook, string>;

export function callStatusLabel(state: VoiceModeState, look: CallLook): string {
  if (look === "connecting" && state.downloading !== null) {
    return `Downloading ${Math.round(state.downloading * 100)}%`;
  }
  return LABELS[look];
}
