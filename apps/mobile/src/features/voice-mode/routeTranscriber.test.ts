import { describe, expect, it } from "vite-plus/test";

import { createRouteTranscriber } from "./routeTranscriber";

const signal = new AbortController().signal;

describe("createRouteTranscriber", () => {
  it("transcribes an utterance on the chosen route and discards its file", async () => {
    const discarded: string[] = [];
    const transcriber = createRouteTranscriber({
      resolve: async () => ({
        prepare: async () => ({
          locale: "en",
          transcribe: async (uri: string) => `heard ${uri}`,
        }),
      }),
      unavailableMessage: () => "unavailable",
      discard: (uri) => discarded.push(uri),
    });

    await transcriber.check(signal);

    await expect(transcriber.transcribe("file:///a.wav", signal)).resolves.toBe(
      "heard file:///a.wav",
    );
    expect(discarded).toEqual(["file:///a.wav"]);
  });

  it("explains why when the route cannot transcribe", async () => {
    const transcriber = createRouteTranscriber({
      resolve: async () => null,
      unavailableMessage: () => "Choose an environment in Settings → Voice.",
      discard: () => {},
    });

    await expect(transcriber.check(signal)).rejects.toMatchObject({
      _tag: "VoiceModeError",
      message: "Choose an environment in Settings → Voice.",
    });
  });

  it("discards the file when transcription fails", async () => {
    const discarded: string[] = [];
    const transcriber = createRouteTranscriber({
      resolve: async () => ({
        prepare: async () => ({
          locale: "en",
          transcribe: async () => {
            throw new Error("The environment went away.");
          },
        }),
      }),
      unavailableMessage: () => "unavailable",
      discard: (uri) => discarded.push(uri),
    });

    await expect(transcriber.transcribe("file:///b.wav", signal)).rejects.toMatchObject({
      message: "The environment went away.",
    });
    expect(discarded).toEqual(["file:///b.wav"]);
  });
});
