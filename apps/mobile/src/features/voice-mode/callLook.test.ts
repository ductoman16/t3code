import type { VoiceModeState } from "@t3tools/client-runtime/voice-mode";
import { describe, expect, it } from "vite-plus/test";

import { callLook, callStatusLabel } from "./callLook";

const on = (activity: VoiceModeState["activity"]): VoiceModeState => ({
  power: "on",
  activity,
  downloading: null,
  error: null,
  notice: null,
});

describe("callLook", () => {
  it.each([
    [on("listening"), false, "listening"],
    [on("listening"), true, "thinking"],
    [on("hearing"), true, "hearing"],
    [on("transcribing"), false, "thinking"],
    [on("sending"), false, "thinking"],
    [on("speaking"), true, "speaking"],
    [{ ...on("listening"), power: "starting" }, false, "connecting"],
  ] as const)("%o with a running turn %s looks %s", (state, turnRunning, look) => {
    expect(callLook(state, turnRunning)).toBe(look);
  });
});

describe("callStatusLabel", () => {
  it("shows a download holding up the start", () => {
    const starting: VoiceModeState = { ...on("listening"), power: "starting" };
    expect(callStatusLabel(starting, "connecting")).toBe("Connecting");
    expect(callStatusLabel({ ...starting, downloading: 0.424 }, "connecting")).toBe(
      "Downloading 42%",
    );
  });
});
