import {
  type EnvironmentSpeechSynthesisRequest,
  SPEECH_SYNTHESIS_DEFAULT_SPEED,
  SPEECH_SYNTHESIS_DEFAULT_VOICE,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { loadKokoro, type KokoroVoice } from "./kokoro.ts";
import { isSpeechPlatformSupported } from "./platform.ts";
import { SpeechOperationError, SpeechUnsupportedPlatformError } from "./SpeechService.ts";

/** A model this size reloads in under a second, so it is not held once voice mode is quiet. */
export const SYNTHESIS_IDLE_UNLOAD_MS = 15 * 60_000;
const WARM_UP_SENTENCE = "Ready.";

export class SpeechUnknownVoiceError extends Schema.TaggedError<SpeechUnknownVoiceError>()(
  "SpeechUnknownVoiceError",
  { voice: Schema.String },
) {}

export type SpeechSynthesisError =
  | SpeechOperationError
  | SpeechUnsupportedPlatformError
  | SpeechUnknownVoiceError;

export class SpeechSynthesis extends Context.Service<
  SpeechSynthesis,
  {
    /** Loads the voice, downloading it the first time, so the first sentence is not held up. */
    readonly prepare: Effect.Effect<void, SpeechSynthesisError>;
    /** Reads one sentence aloud as a 16-bit mono WAV file. Sentences are read one at a time, in order. */
    readonly speak: (
      request: EnvironmentSpeechSynthesisRequest,
    ) => Effect.Effect<Uint8Array, SpeechSynthesisError>;
  }
>()("t3/speech/SpeechSynthesis") {}

export const make = Effect.fn("SpeechSynthesis.make")(function* (input: {
  readonly load: (cacheDirectory: string) => Promise<KokoroVoice>;
  readonly cacheDirectory: string;
  readonly unsupported: SpeechUnsupportedPlatformError | null;
}) {
  const clock = yield* Clock.Clock;
  const now = () => clock.currentTimeMillisUnsafe();
  // Loading and reading share one permit: the runtime runs one sentence at a time anyway, and a
  // queue keeps them in the order they were asked for.
  const permit = yield* Semaphore.make(1);
  let voice: KokoroVoice | undefined;

  const unloadRequests = yield* Queue.sliding<number>(1);
  const unload = Effect.promise(async () => {
    const loaded = voice;
    voice = undefined;
    await loaded?.dispose().catch(() => undefined);
  });
  yield* Stream.fromQueue(unloadRequests).pipe(
    Stream.switchMap((deadline) =>
      Stream.fromEffect(
        Effect.sleep(Math.max(0, deadline - now())).pipe(
          Effect.andThen(permit.withPermits(1)(unload)),
        ),
      ),
    ),
    Stream.runDrain,
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() => unload);

  const loaded = Effect.suspend((): Effect.Effect<KokoroVoice, SpeechSynthesisError> => {
    if (input.unsupported) return Effect.fail(input.unsupported);
    if (voice) return Effect.succeed(voice);
    return Effect.tryPromise({
      try: async () => {
        const created = await input.load(input.cacheDirectory);
        // The first sentence runs slower while the runtime settles; spend that before a reply.
        await created.generate(WARM_UP_SENTENCE, {
          voice: SPEECH_SYNTHESIS_DEFAULT_VOICE,
          speed: SPEECH_SYNTHESIS_DEFAULT_SPEED,
        });
        voice = created;
        return created;
      },
      catch: (cause) => new SpeechOperationError({ operation: "voice loading", cause }),
    });
  });
  const exclusive = <A, E>(effect: Effect.Effect<A, E>) =>
    permit
      .withPermits(1)(effect)
      .pipe(Effect.ensuring(Queue.offer(unloadRequests, now() + SYNTHESIS_IDLE_UNLOAD_MS)));

  return SpeechSynthesis.of({
    prepare: exclusive(Effect.asVoid(loaded)),
    speak: Effect.fn("SpeechSynthesis.speak")((request) =>
      exclusive(
        Effect.gen(function* () {
          const ready = yield* loaded;
          if (!ready.voices.has(request.voice))
            return yield* new SpeechUnknownVoiceError({ voice: request.voice });
          const audio = yield* Effect.tryPromise({
            try: () => ready.generate(request.text, { voice: request.voice, speed: request.speed }),
            catch: (cause) => new SpeechOperationError({ operation: "speech synthesis", cause }),
          });
          return encodeWav(audio.samples, audio.sampleRate);
        }),
      ),
    ),
  });
});

export const layer = Layer.effect(
  SpeechSynthesis,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const architecture = yield* HostProcess.Architecture;
    const libc = platform === "linux" ? yield* HostProcess.LinuxLibc : undefined;
    return yield* make({
      load: loadKokoro,
      cacheDirectory: path.join(config.stateDir, "speech", "kokoro"),
      unsupported: isSpeechPlatformSupported(platform, architecture, libc)
        ? null
        : new SpeechUnsupportedPlatformError({ platform, architecture }),
    });
  }),
);

/** Mono float samples as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const header = 44;
  const bytes = new Uint8Array(header + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++)
      view.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]!));
    view.setInt16(header + index * 2, Math.round(sample * 32767), true);
  }
  return bytes;
}
