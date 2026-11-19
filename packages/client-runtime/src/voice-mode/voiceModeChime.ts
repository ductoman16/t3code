import type { VoiceModeState } from "./voiceModeController.ts";

/** Heard when voice mode comes on, when it sends a message, and when it goes off for any reason. */
export type VoiceModeChime = "start" | "sent" | "stop";

/**
 * Short sine notes: two rising to start, two falling to stop, and one high blip when a message is
 * sent. The Android module synthesizes the same notes natively (VoiceModeChime.kt), so keep the two
 * in step.
 */
export const VOICE_MODE_CHIME = {
  notesHz: { start: [660, 880], sent: [1320], stop: [880, 660] },
  noteMs: 90,
  attackMs: 8,
  releaseMs: 40,
  /** Peak amplitude, from 0 to 1. */
  peak: 0.25,
} as const satisfies {
  readonly notesHz: Record<VoiceModeChime, readonly number[]>;
  readonly noteMs: number;
  readonly attackMs: number;
  readonly releaseMs: number;
  readonly peak: number;
};

/**
 * Calls `play("start")` each time voice mode comes on, `play("sent")` each time it sends a message,
 * and `play("stop")` each time it goes off, whether it was turned off, failed, or never finished
 * starting.
 */
export function watchVoiceModeChimes(
  voiceMode: {
    readonly state: VoiceModeState;
    readonly subscribe: (listener: () => void) => () => void;
  },
  play: (chime: VoiceModeChime) => void,
): () => void {
  let { power, sent } = voiceMode.state;
  return voiceMode.subscribe(() => {
    const previous = { power, sent };
    ({ power, sent } = voiceMode.state);
    if (previous.power !== power) {
      if (power === "on") play("start");
      else if (power === "off") play("stop");
    } else if (power === "on" && sent > previous.sent) {
      play("sent");
    }
  });
}
