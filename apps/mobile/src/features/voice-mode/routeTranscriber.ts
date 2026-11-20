import type {
  PreparedVoiceTranscription,
  VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import {
  isVoiceModeError,
  VoiceModeError,
  type VoiceModeTranscriber,
} from "@t3tools/client-runtime/voice-mode";
import { msg } from "gt-react-native";

import { m } from "../../i18n/messages";

/**
 * Transcribes each utterance file the way dictation would, on the route chosen in Settings →
 * Voice: on the phone, or on an environment.
 */
export function createRouteTranscriber(input: {
  /** The chosen route's transcriber, or null when it cannot work now. */
  readonly resolve: () => Promise<VoiceTranscriber | null>;
  readonly unavailableMessage: () => string;
  /** Removes an utterance file once it has been heard. */
  readonly discard: (uri: string) => void;
}): VoiceModeTranscriber<string> {
  let prepared: Promise<PreparedVoiceTranscription> | null = null;

  async function prepare(signal: AbortSignal): Promise<PreparedVoiceTranscription> {
    const transcriber = await input.resolve();
    if (!transcriber) throw new VoiceModeError({ message: input.unavailableMessage() });
    try {
      return await transcriber.prepare({ signal });
    } catch (cause) {
      throw new VoiceModeError({ message: messageOf(cause), cause });
    }
  }

  return {
    async check(signal) {
      // Prepared again each time voice mode comes on, so a changed route is followed.
      prepared = prepare(signal);
      prepared.catch(() => {
        prepared = null;
      });
      await prepared;
    },
    async transcribe(uri, signal) {
      try {
        const transcription = await (prepared ?? prepare(signal));
        return await transcription.transcribe(uri, { signal });
      } catch (cause) {
        if (isVoiceModeError(cause)) throw cause;
        throw new VoiceModeError({ message: messageOf(cause), cause });
      } finally {
        input.discard(uri);
      }
    },
  };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error && cause.message !== ""
    ? cause.message
    : m(msg("That phrase could not be transcribed."));
}
