import * as Schema from "effect/Schema";

import { readLocalStorageValue } from "../hooks/useLocalStorage";

const KEY = "t3code:voice-mode:v1";

const VoiceModeSettings = Schema.Struct({
  /** A Kokoro voice id; the first letter is its language, the second its gender. */
  voice: Schema.String,
  speed: Schema.Number,
  /** Quiet time after a phrase before the draft is sent. Shorter feels livelier and cuts in sooner. */
  sendAfterSilenceMs: Schema.Number,
});
type VoiceModeSettings = typeof VoiceModeSettings.Type;

const DEFAULTS: VoiceModeSettings = { voice: "af_heart", speed: 1.1, sendAfterSilenceMs: 900 };

export function readVoiceModeSettings(): VoiceModeSettings {
  return readLocalStorageValue(KEY, DEFAULTS, VoiceModeSettings);
}
