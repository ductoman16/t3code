import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  getEnvironmentSpeechStatus,
  requireCloudSpeechKey,
  transcribeCloudPcm,
  transcribeEnvironmentPcm,
} from "@t3tools/client-runtime/voice-input";
import type {
  CloudSpeechModelId,
  CloudSpeechProvider,
  SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import { resolveSpeechVocabulary } from "@t3tools/shared/speech";

import { getClientSettings } from "../hooks/useSettings";
import { runEnvironmentSpeech } from "../speech/runEnvironmentSpeech";
import { bindAudioGrant } from "../speech/voiceConsent";
import { isVoiceModeError, VoiceModeError, type VoiceModeTranscriber } from "./voiceModeController";

/** Where the person chose, in Settings → Voice, to have their speech transcribed. */
export interface TranscriptionDestination {
  readonly grantId: string | null;
  readonly label: string | null;
  /** Null while the chosen environment is disconnected or lacks transcription. */
  readonly prepared: PreparedConnection | null;
  readonly cloudProvider?: CloudSpeechProvider | undefined;
  readonly cloudModel?: CloudSpeechModelId | undefined;
}

const NOT_CHOSEN =
  "Voice mode needs somewhere to transcribe your speech. Choose it in Settings → Voice → Transcribe with, then turn voice mode on again.";

function unavailable(destination: TranscriptionDestination): VoiceModeError {
  return new VoiceModeError({
    message: `Voice mode could not reach "${destination.label ?? "the transcription environment"}" to transcribe your speech. Check that it is connected and supports transcription, or choose another in Settings → Voice.`,
  });
}

function transcriptionOptions(): SpeechTranscriptionOptions {
  const settings = getClientSettings();
  return {
    speechLanguage: settings.speechLanguage,
    speechTranslateToEnglish: settings.speechTranslateToEnglish,
    speechCustomWords: resolveSpeechVocabulary({
      personal: settings.speechCustomWords,
      project: [],
    }),
    speechRemoveFillerWords: settings.speechRemoveFillerWords,
    speechSilenceFiltering: settings.speechSilenceFiltering,
  };
}

function failure(error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted || isVoiceModeError(error)) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new VoiceModeError({
    message: `Voice mode could not transcribe your speech: ${detail}`,
    cause: error,
  });
}

/**
 * Transcribes with the destination the person chose for dictation, under the same consent.
 * Audio goes nowhere else, and revoking that choice stops voice mode at the next phrase.
 */
export function createEnvironmentTranscriber(
  readDestination: () => TranscriptionDestination | null,
): VoiceModeTranscriber {
  const requireDestination = () => {
    const destination = readDestination();
    if (!destination?.grantId) throw new VoiceModeError({ message: NOT_CHOSEN });
    if (!destination.prepared) throw unavailable(destination);
    return { ...destination, grantId: destination.grantId, prepared: destination.prepared };
  };

  return {
    async check(signal) {
      const destination = requireDestination();
      try {
        if (destination.cloudProvider) {
          await runEnvironmentSpeech(
            requireCloudSpeechKey(destination.prepared, destination.cloudProvider),
            { signal },
          );
          return;
        }
        const status = await runEnvironmentSpeech(
          getEnvironmentSpeechStatus(destination.prepared),
          {
            signal,
          },
        );
        if (!status.supported) throw new VoiceModeError({ message: status.reason });
        if (status.state === "missing-model") {
          throw new VoiceModeError({
            message: `Voice mode needs the "${status.model}" transcription model on "${destination.label ?? "the transcription environment"}". Download it in Settings → Voice, then turn voice mode on again.`,
          });
        }
      } catch (error) {
        throw failure(error, signal);
      }
    },

    async transcribe(audio, signal) {
      const destination = requireDestination();
      const hasConsent = bindAudioGrant(destination.grantId);
      const pcm = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
      try {
        const result = await runEnvironmentSpeech(
          destination.cloudProvider
            ? transcribeCloudPcm(
                destination.prepared,
                destination.cloudProvider,
                pcm,
                transcriptionOptions(),
                hasConsent,
                destination.cloudModel,
              )
            : transcribeEnvironmentPcm(
                destination.prepared,
                pcm,
                transcriptionOptions(),
                hasConsent,
              ),
          { signal },
        );
        return result.text;
      } catch (error) {
        throw failure(error, signal);
      }
    },
  };
}
