import { afterEach, expect, it, vi } from "vite-plus/test";

import { createKokoroSpeaker } from "./kokoroSpeaker";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("stays active until the last rendered sample drains through the output device", async () => {
  vi.useFakeTimers();
  let worker: EventTarget;
  class TestWorker extends EventTarget {
    constructor() {
      super();
      worker = this;
    }
    postMessage() {}
    terminate() {}
  }
  const source = Object.assign(new EventTarget(), { connect() {}, start() {}, stop() {} });
  vi.stubGlobal("window", { location: { href: "https://example.test/" } });
  vi.stubGlobal("Worker", TestWorker);
  vi.stubGlobal(
    "AudioContext",
    class {
      currentTime = 0;
      baseLatency = 0.01;
      outputLatency = 0.15;
      createBuffer() {
        return { duration: 1, copyToChannel() {} };
      }
      createBufferSource() {
        return source;
      }
      async close() {}
    },
  );

  const speaker = createKokoroSpeaker(() => ({ voice: "af_heart", speed: 1 }));
  const ready = speaker.prepare({
    signal: new AbortController().signal,
    onDownloadProgress() {},
    onFailure(error) {
      throw error;
    },
  });
  const message = (data: unknown) => worker.dispatchEvent(new MessageEvent("message", { data }));
  message({ type: "ready" });
  await ready;
  speaker.say("Hello.");
  message({
    type: "audio",
    id: 0,
    generation: 0,
    samples: new Float32Array(24_000),
    sampleRate: 24_000,
  });
  source.dispatchEvent(new Event("ended"));
  vi.advanceTimersByTime(159);
  expect(speaker.isActive()).toBe(true);
  vi.advanceTimersByTime(1);
  expect(speaker.isActive()).toBe(false);
  speaker.shutDown();
});
