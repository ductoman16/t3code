import { describe, expect, it } from "vite-plus/test";

import { utterancePcmBytes } from "./utterancePcm";

function samples(bytes: Uint8Array): number[] {
  return Array.from(new Float32Array(Uint8Array.from(bytes).buffer));
}

describe("utterancePcmBytes", () => {
  it("clips loud microphone samples into the [-1, 1] range transcription accepts", () => {
    // Chromium's float microphone stream is not clipped, so loud speech with gain control on
    // reaches past full scale. The environment rejects any such sample as invalid audio.
    const utterance = new Float32Array([0.25, 1.375, -1.5, -0.5]);

    expect(samples(utterancePcmBytes(utterance))).toEqual([0.25, 1, -1, -0.5]);
  });
});
