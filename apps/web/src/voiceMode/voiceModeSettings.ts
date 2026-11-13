import * as Schema from "effect/Schema";

import {
  readLocalStorageValue,
  useLocalStorage,
  writeLocalStorageValue,
} from "../hooks/useLocalStorage";

const KEY = "t3code:voice-mode:v1";

const VoiceModeSettings = Schema.Struct({
  /** A Kokoro voice id; the first letter is its language, the second its gender. */
  voice: Schema.String,
  /** How fast replies are read, as a multiple of the voice's natural pace. */
  speed: Schema.Number,
  /** Quiet time after a phrase before the draft is sent. Shorter feels livelier and cuts in sooner. */
  sendAfterSilenceMs: Schema.Number,
});
type VoiceModeSettings = typeof VoiceModeSettings.Type;

const DEFAULTS: VoiceModeSettings = { voice: "af_heart", speed: 1.1, sendAfterSilenceMs: 900 };

/** The reading speeds offered in Settings. */
export const VOICE_MODE_SPEEDS = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.5, 1.75, 2] as const;

export function readVoiceModeSettings(): VoiceModeSettings {
  return readLocalStorageValue(KEY, DEFAULTS, VoiceModeSettings);
}

export function useVoiceModeSettings(): VoiceModeSettings {
  return useLocalStorage(KEY, DEFAULTS, VoiceModeSettings)[0];
}

/** Takes effect from the next sentence read aloud. */
export function updateVoiceModeSettings(patch: Partial<VoiceModeSettings>): void {
  writeLocalStorageValue(KEY, (current) => ({ ...current, ...patch }), DEFAULTS, VoiceModeSettings);
}
