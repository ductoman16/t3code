import { describe, expect, it } from "vite-plus/test";

import { createAndroidSpeaker } from "./androidSpeaker";
import type { NativeVoiceEvent } from "./nativeVoiceMode";

function setUp() {
  let onVoice: ((event: NativeVoiceEvent) => void) | null = null;
  const said: { id: string; text: string; rate: number }[] = [];
  let stops = 0;
  let time = 0;
  const native = {
    addListener: (_event: "onVoice", listener: (event: NativeVoiceEvent) => void) => {
      onVoice = listener;
      return { remove: () => (onVoice = null) };
    },
    prepareVoice: async () => {},
    say: (id: string, text: string, rate: number) => said.push({ id, text, rate }),
    stopSpeaking: () => {
      stops += 1;
    },
    shutDownVoice: () => {},
  };
  const speaker = createAndroidSpeaker(
    native as unknown as Parameters<typeof createAndroidSpeaker>[0],
    () => 1.2,
    () => time,
  );
  const voice = (type: NativeVoiceEvent["type"], id: string) => onVoice?.({ type, id });
  return {
    speaker,
    said,
    voice,
    stops: () => stops,
    advance: (ms: number) => (time += ms),
  };
}

const prepared = async () => {
  const context = setUp();
  await context.speaker.prepare({
    signal: new AbortController().signal,
    onDownloadProgress: () => {},
    onFailure: () => {},
  });
  return context;
};

describe("createAndroidSpeaker", () => {
  it("queues sentences at the reading speed and is active until the last is said", async () => {
    const { speaker, said, voice } = await prepared();
    let changes = 0;
    speaker.subscribe(() => (changes += 1));

    speaker.say("One.");
    speaker.say("Two.");
    expect(said.map((entry) => [entry.text, entry.rate])).toEqual([
      ["One.", 1.2],
      ["Two.", 1.2],
    ]);
    expect(speaker.isActive()).toBe(true);

    voice("done", said[0]!.id);
    expect(speaker.isActive()).toBe(true);
    voice("done", said[1]!.id);
    expect(speaker.isActive()).toBe(false);
    expect(changes).toBe(2);
  });

  it("says the cut-off sentence again after a pause", async () => {
    const { speaker, said, voice, stops } = await prepared();
    speaker.say("One.");
    speaker.say("Two.");
    voice("done", said[0]!.id);

    speaker.pause();
    // Android reports the stopped sentence as over; it is kept for the resume.
    voice("done", said[1]!.id);
    expect(stops()).toBe(1);
    expect(speaker.isActive()).toBe(true);

    speaker.resume();
    expect(said.at(-1)?.text).toBe("Two.");
    expect(said.at(-1)?.id).not.toBe(said[1]!.id);
  });

  it("holds a sentence that arrives during a pause until the resume", async () => {
    const { speaker, said, stops } = await prepared();

    speaker.pause();
    speaker.say("On it.");
    expect(said).toEqual([]);
    expect(stops()).toBe(0);
    expect(speaker.isActive()).toBe(true);

    speaker.resume();
    expect(said.map((entry) => entry.text)).toEqual(["On it."]);
  });

  it("drops everything on stop", async () => {
    const { speaker } = await prepared();
    speaker.say("One.");

    speaker.stop();

    expect(speaker.isActive()).toBe(false);
  });

  it("captions the sentence being read, keeps the last one, and clears it when stopped", async () => {
    const { speaker, said, voice } = await prepared();
    let changes = 0;
    speaker.subscribeCaption(() => (changes += 1));
    speaker.say("One.");
    speaker.say("Two.");
    expect(speaker.caption()).toBe("");

    voice("start", said[0]!.id);
    expect(speaker.caption()).toBe("One.");
    voice("done", said[0]!.id);
    voice("start", said[1]!.id);
    expect(speaker.caption()).toBe("Two.");
    voice("done", said[1]!.id);
    expect(speaker.caption()).toBe("Two.");

    speaker.stop();
    expect(speaker.caption()).toBe("");
    expect(changes).toBe(3);
  });

  it("remembers what it said for a moment, as the microphone may hear it", async () => {
    const { speaker, said, voice, advance } = await prepared();
    speaker.say("Hello there.");
    voice("start", said[0]!.id);
    expect(speaker.recentText()).toBe("Hello there.");

    voice("done", said[0]!.id);
    advance(1000);
    expect(speaker.recentText()).toBe("Hello there.");
    advance(1500);
    expect(speaker.recentText()).toBe("");
  });
});
