import { describe, expect, it } from "vite-plus/test";

import { createAndroidSpeaker } from "./androidSpeaker";
import { environmentVoice } from "./environmentVoice";
import type { NativeVoiceEvent } from "./nativeVoiceMode";

interface Request {
  readonly text: string;
  readonly speed: number;
  readonly signal: AbortSignal;
  readonly resolve: (wav: Uint8Array) => void;
  readonly reject: (error: Error) => void;
}

/** Resolves once `count()` reaches `target`, checked each time `changed` is called. */
function milestones(count: () => number) {
  const waiting: { target: number; resolve: () => void }[] = [];
  return {
    changed() {
      for (const waiter of waiting.filter((entry) => count() >= entry.target)) {
        waiting.splice(waiting.indexOf(waiter), 1);
        waiter.resolve();
      }
    },
    reach: (target: number) =>
      count() >= target
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiting.push({ target, resolve })),
  };
}

function setUp() {
  const listeners = new Set<(event: NativeVoiceEvent) => void>();
  const played: { id: string; wav: Uint8Array }[] = [];
  const requests: Request[] = [];
  const failures: unknown[] = [];
  const playing = milestones(() => played.length);
  const requesting = milestones(() => requests.length);
  const failing = milestones(() => failures.length);
  let stops = 0;
  const native = {
    addListener: (_event: "onVoice", listener: (event: NativeVoiceEvent) => void) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    preparePlayer: () => {},
    play: (id: string, wav: Uint8Array) => {
      played.push({ id, wav });
      playing.changed();
    },
    stopSpeaking: () => {
      stops += 1;
    },
    shutDownVoice: () => {},
  };
  const synthesizer = {
    prepare: async () => {},
    speak: (text: string, speed: number, signal: AbortSignal) =>
      new Promise<Uint8Array>((resolve, reject) => {
        requests.push({ text, speed, signal, resolve, reject });
        requesting.changed();
      }),
  };
  const speaker = createAndroidSpeaker(
    native as unknown as Parameters<typeof createAndroidSpeaker>[0],
    () =>
      environmentVoice(
        native as unknown as Parameters<typeof environmentVoice>[0],
        synthesizer,
        () => 1.1,
      ),
  );
  const emit = (type: "start" | "done", id: string) => {
    for (const listener of listeners) listener({ type, id });
  };
  return {
    speaker,
    played,
    requests,
    failures,
    emit,
    stops: () => stops,
    untilPlayed: playing.reach,
    untilRequested: requesting.reach,
    untilFailed: failing.reach,
    /** Answers request `index` with audio that decodes to its text. */
    finish: async (index: number) => {
      await requesting.reach(index + 1);
      const request = requests[index]!;
      request.resolve(new TextEncoder().encode(request.text));
    },
    playedText: () => played.map((entry) => new TextDecoder().decode(entry.wav)),
    prepare: () =>
      speaker.prepare({
        signal: new AbortController().signal,
        onDownloadProgress: () => {},
        onFailure: (error) => {
          failures.push(error);
          failing.changed();
        },
      }),
  };
}

describe("environmentVoice", () => {
  it("synthesizes ahead one sentence at a time and plays each as soon as it is ready", async () => {
    const context = setUp();
    await context.prepare();

    context.speaker.say("One.");
    context.speaker.say("Two.");
    context.speaker.say("Three.");
    await context.untilRequested(1);
    expect(context.requests.map((request) => [request.text, request.speed])).toEqual([
      ["One.", 1.1],
    ]);

    await context.finish(0);
    await context.untilPlayed(1);
    expect(context.playedText()).toEqual(["One."]);

    await context.finish(1);
    await context.finish(2);
    await context.untilPlayed(3);
    expect(context.playedText()).toEqual(["One.", "Two.", "Three."]);
  });

  it("replays the cut-off sentence on resume without synthesizing it again", async () => {
    const context = setUp();
    await context.prepare();
    context.speaker.say("One.");
    context.speaker.say("Two.");
    await context.finish(0);
    await context.finish(1);
    await context.untilPlayed(2);
    context.emit("start", context.played[0]!.id);
    context.emit("done", context.played[0]!.id);
    context.emit("start", context.played[1]!.id);

    context.speaker.pause();
    expect(context.stops()).toBe(1);
    expect(context.speaker.isActive()).toBe(true);
    context.speaker.resume();
    await context.untilPlayed(3);

    expect(context.playedText()).toEqual(["One.", "Two.", "Two."]);
    expect(context.played[2]!.id).not.toBe(context.played[1]!.id);
    expect(context.requests).toHaveLength(2);
  });

  it("gets a sentence that arrives during a pause ready, and plays it only on resume", async () => {
    const context = setUp();
    await context.prepare();

    context.speaker.pause();
    context.speaker.say("On it.");
    await context.finish(0);
    expect(context.speaker.isActive()).toBe(true);

    context.speaker.resume();
    await context.untilPlayed(1);
    expect(context.playedText()).toEqual(["On it."]);
    expect(context.requests).toHaveLength(1);
  });

  it("drops everything on stop, including audio still being synthesized", async () => {
    const context = setUp();
    await context.prepare();
    context.speaker.say("One.");
    context.speaker.say("Two.");
    await context.untilRequested(1);

    context.speaker.stop();
    expect(context.requests[0]!.signal.aborted).toBe(true);
    expect(context.speaker.isActive()).toBe(false);
    await context.finish(0);

    context.speaker.say("Fresh.");
    await context.finish(1);
    await context.untilPlayed(1);
    expect(context.requests.map((request) => request.text)).toEqual(["One.", "Fresh."]);
    expect(context.playedText()).toEqual(["Fresh."]);
    expect(context.failures).toEqual([]);
  });

  it("stops voice mode with the reason when the environment cannot read a sentence", async () => {
    const context = setUp();
    await context.prepare();
    context.speaker.say("One.");
    await context.untilRequested(1);

    context.requests[0]!.reject(new Error("The environment is offline."));
    await context.untilFailed(1);

    expect(context.failures).toEqual([
      expect.objectContaining({
        _tag: "VoiceModeError",
        message: "The voice stopped working: The environment is offline.",
      }),
    ]);
    expect(context.played).toEqual([]);
  });
});
