import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import type { KokoroVoice } from "./kokoro.ts";
import * as SpeechSynthesis from "./SpeechSynthesis.ts";
import { SpeechUnsupportedPlatformError } from "./SpeechService.ts";

function fakeKokoro(options: { readonly failLoads?: number } = {}) {
  let failLoads = options.failLoads ?? 0;
  const calls = { loads: 0, disposals: 0, said: [] as string[], cacheDirectories: [] as string[] };
  const pending: Array<() => void> = [];
  let holdNext = false;
  const voice: KokoroVoice = {
    voices: new Set(["af_heart"]),
    generate: async (text) => {
      if (holdNext) {
        holdNext = false;
        await new Promise<void>((resolve) => pending.push(resolve));
      }
      calls.said.push(text);
      return { samples: new Float32Array([0, 1, -1]), sampleRate: 24_000 };
    },
    dispose: async () => {
      calls.disposals += 1;
    },
  };
  return {
    calls,
    holdNextSentence: () => (holdNext = true),
    release: () => pending.shift()?.(),
    load: async (cacheDirectory: string) => {
      calls.loads += 1;
      calls.cacheDirectories.push(cacheDirectory);
      if (failLoads > 0) {
        failLoads -= 1;
        throw new Error("offline");
      }
      return voice;
    },
  };
}

const sentence = (text: string) => ({ text, voice: "af_heart", speed: 1.1 });

it.effect("loads and warms the voice once, then reads sentences in the order asked", () =>
  Effect.gen(function* () {
    const kokoro = fakeKokoro();
    const synthesis = yield* SpeechSynthesis.make({
      load: kokoro.load,
      cacheDirectory: "/state/speech/kokoro",
      unsupported: null,
    });

    yield* synthesis.prepare;
    kokoro.holdNextSentence();
    const first = yield* Effect.forkChild(synthesis.speak(sentence("One.")));
    const second = yield* Effect.forkChild(synthesis.speak(sentence("Two.")));
    yield* Effect.yieldNow;
    expect(kokoro.calls.said).toEqual(["Ready."]);
    kokoro.release();
    const audio = yield* Fiber.join(first);
    yield* Fiber.join(second);

    expect(kokoro.calls.loads).toBe(1);
    expect(kokoro.calls.cacheDirectories).toEqual(["/state/speech/kokoro"]);
    expect(kokoro.calls.said).toEqual(["Ready.", "One.", "Two."]);
    expect(Array.from(audio.subarray(44))).toEqual([0, 0, 0xff, 0x7f, 0x01, 0x80]);
  }).pipe(Effect.scoped),
);

it.effect("tries loading again after a failed load", () =>
  Effect.gen(function* () {
    const kokoro = fakeKokoro({ failLoads: 1 });
    const synthesis = yield* SpeechSynthesis.make({
      load: kokoro.load,
      cacheDirectory: "/cache",
      unsupported: null,
    });

    const failed = yield* Effect.flip(synthesis.prepare);
    expect(failed._tag).toBe("SpeechOperationError");
    yield* synthesis.speak(sentence("Back."));
    expect(kokoro.calls.loads).toBe(2);
  }).pipe(Effect.scoped),
);

it.effect("refuses a voice the model does not have and an unsupported host", () =>
  Effect.gen(function* () {
    const kokoro = fakeKokoro();
    const synthesis = yield* SpeechSynthesis.make({
      load: kokoro.load,
      cacheDirectory: "/cache",
      unsupported: null,
    });
    const unknown = yield* Effect.flip(
      synthesis.speak({ text: "Hi.", voice: "zz_nobody", speed: 1 }),
    );
    expect(unknown._tag).toBe("SpeechUnknownVoiceError");

    const unsupported = yield* SpeechSynthesis.make({
      load: kokoro.load,
      cacheDirectory: "/cache",
      unsupported: new SpeechUnsupportedPlatformError({ platform: "win32", architecture: "arm64" }),
    });
    const refused = yield* Effect.flip(unsupported.speak(sentence("Hi.")));
    expect(refused._tag).toBe("SpeechUnsupportedPlatformError");
    expect(kokoro.calls.loads).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("releases the voice after it has been idle, and loads it again when next asked", () =>
  Effect.gen(function* () {
    const kokoro = fakeKokoro();
    const synthesis = yield* SpeechSynthesis.make({
      load: kokoro.load,
      cacheDirectory: "/cache",
      unsupported: null,
    });
    yield* synthesis.speak(sentence("One."));

    yield* TestClock.adjust(SpeechSynthesis.SYNTHESIS_IDLE_UNLOAD_MS - 1);
    yield* synthesis.speak(sentence("Two."));
    yield* TestClock.adjust(SpeechSynthesis.SYNTHESIS_IDLE_UNLOAD_MS - 1);
    expect(kokoro.calls.disposals).toBe(0);

    yield* TestClock.adjust(1);
    expect(kokoro.calls.disposals).toBe(1);
    yield* synthesis.speak(sentence("Three."));
    expect(kokoro.calls.loads).toBe(2);
  }).pipe(Effect.scoped),
);

it("encodes a 16-bit mono WAV header", () => {
  const wav = SpeechSynthesis.encodeWav(new Float32Array(3), 24_000);
  const view = new DataView(wav.buffer);
  const text = (offset: number) => String.fromCharCode(...wav.subarray(offset, offset + 4));
  expect([text(0), text(8), text(12), text(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
  expect(view.getUint32(4, true)).toBe(wav.length - 8);
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint32(24, true)).toBe(24_000);
  expect(view.getUint16(34, true)).toBe(16);
  expect(view.getUint32(40, true)).toBe(6);
});
