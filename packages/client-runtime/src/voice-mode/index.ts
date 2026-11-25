export * from "./voiceModeController.ts";
export { VOICE_MODE_CHIME, watchVoiceModeChimes, type VoiceModeChime } from "./voiceModeChime.ts";
export { createReplyReader, type TimelineItem } from "./replyReader.ts";

export const VOICE_MODE_DEFAULT_SPEED = 1.1;
export const VOICE_MODE_SPEEDS = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.75, 2] as const;
