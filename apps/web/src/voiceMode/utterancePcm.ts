/**
 * The utterance as the 16 kHz mono Float32 PCM bytes transcription accepts.
 *
 * Chromium's microphone stream is float and unclipped, so loud speech with gain control on goes
 * past full scale, and the environment rejects any sample outside [-1, 1] as invalid audio.
 * Clip it here as dictation's capture does.
 */
export function utterancePcmBytes(utterance: Float32Array): Uint8Array {
  const pcm = utterance.map((sample) => Math.max(-1, Math.min(1, sample)));
  return new Uint8Array(pcm.buffer);
}
