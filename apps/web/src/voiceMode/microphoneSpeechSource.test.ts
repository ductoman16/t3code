import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createMicrophoneSpeechSource } from "./microphoneSpeechSource";

// Stands in for MicVAD, which only ever sees the source's steady stream.
vi.mock("@ricky0123/vad-web", () => ({
  MicVAD: {
    async new(options: { getStream: () => Promise<MediaStream> }) {
      await options.getStream();
      return { destroy: async () => {} };
    },
  },
}));

class FakeTrack extends EventTarget {
  readyState: MediaStreamTrackState = "live";
  constructor(readonly groupId: string) {
    super();
  }
  getSettings() {
    return { groupId: this.groupId };
  }
  stop() {
    this.readyState = "ended";
  }
  /** The device was unplugged. */
  disconnect() {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

const trackOf = (stream: MediaStream) => stream.getAudioTracks()[0] as unknown as FakeTrack;

function setup(initial: { chosen: string; systemDefault: string }) {
  const state = { ...initial };
  const devices = new EventTarget();
  const tracks: FakeTrack[] = [];
  const opened: string[] = [];
  /** What the detector hears now: the microphones plugged into the steady stream. */
  const pluggedIn = new Set<FakeTrack>();
  const contexts: Array<{ close: ReturnType<typeof vi.fn> }> = [];

  const mediaDevices = Object.assign(devices, {
    getUserMedia: vi.fn(async (constraints: MediaStreamConstraints) => {
      const audio = constraints.audio as MediaTrackConstraints;
      const exact = (audio.deviceId as { exact?: string } | undefined)?.exact;
      opened.push(exact ?? "default");
      const track = new FakeTrack(exact ?? state.systemDefault);
      tracks.push(track);
      return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
    }),
    enumerateDevices: vi.fn(async () => [
      { kind: "audioinput", deviceId: "default", groupId: state.systemDefault },
    ]),
  });
  vi.stubGlobal("navigator", { mediaDevices });
  vi.stubGlobal(
    "AudioContext",
    class {
      close = vi.fn(async () => {});
      constructor() {
        contexts.push(this);
      }
      createMediaStreamDestination() {
        return { stream: {} as MediaStream };
      }
    },
  );
  vi.stubGlobal(
    "MediaStreamAudioSourceNode",
    class {
      private readonly track: FakeTrack;
      constructor(_context: unknown, init: { mediaStream: MediaStream }) {
        this.track = trackOf(init.mediaStream);
      }
      connect() {
        pluggedIn.add(this.track);
      }
      disconnect() {
        pluggedIn.delete(this.track);
      }
    },
  );

  const handlers = {
    onSpeechStart: vi.fn(),
    onSpeechConfirmed: vi.fn(),
    onSpeechCancel: vi.fn(),
    onUtterance: vi.fn(),
    onError: vi.fn(),
  };
  const source = createMicrophoneSpeechSource(handlers, {
    chooseMicrophone: async () => state.chosen,
  });
  const devicesChanged = () => devices.dispatchEvent(new Event("devicechange"));
  const hearing = () => [...pluggedIn].map((track) => track.groupId);
  return {
    state,
    source,
    handlers,
    tracks,
    opened,
    mediaDevices,
    contexts,
    devicesChanged,
    hearing,
  };
}

/** Waits for the check the source runs once it has started. */
async function started(env: ReturnType<typeof setup>) {
  await env.source.start();
  await vi.waitFor(() => expect(env.mediaDevices.enumerateDevices).toHaveBeenCalledOnce());
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createMicrophoneSpeechSource", () => {
  it("moves the call to headphones that become the system default", async () => {
    const env = setup({ chosen: "", systemDefault: "laptop" });
    await started(env);

    env.state.systemDefault = "headset";
    env.devicesChanged();

    await vi.waitFor(() => expect(env.hearing()).toEqual(["headset"]));
    expect(env.tracks.map((track) => track.readyState)).toEqual(["ended", "live"]);
  });

  it("moves to the microphone Settings → Voice's order picks once it connects", async () => {
    const env = setup({ chosen: "", systemDefault: "laptop" });
    await started(env);

    env.state.chosen = "headset";
    env.devicesChanged();

    await vi.waitFor(() => expect(env.opened).toEqual(["default", "headset"]));
    expect(env.hearing()).toEqual(["headset"]);
  });

  it("treats a saved Chromium default alias as the system default", async () => {
    const env = setup({ chosen: "default", systemDefault: "laptop" });
    await started(env);

    env.state.systemDefault = "headset";
    env.devicesChanged();

    await vi.waitFor(() => expect(env.hearing()).toEqual(["headset"]));
    expect(env.opened).toEqual(["default", "default"]);
  });

  it("keeps the microphone when a change does not affect it", async () => {
    const env = setup({ chosen: "", systemDefault: "laptop" });
    await started(env);

    env.devicesChanged();
    await vi.waitFor(() => expect(env.mediaDevices.enumerateDevices).toHaveBeenCalledTimes(2));
    env.state.systemDefault = "headset";
    env.devicesChanged();

    // Only the second change, which did affect it, opened another microphone.
    await vi.waitFor(() => expect(env.hearing()).toEqual(["headset"]));
    expect(env.opened).toEqual(["default", "default"]);
  });

  it("reopens a microphone whose device dropped out and came back", async () => {
    const env = setup({ chosen: "", systemDefault: "laptop" });
    await started(env);

    env.tracks[0]?.disconnect();

    await vi.waitFor(() => expect(env.opened).toEqual(["default", "default"]));
    expect(env.hearing()).toEqual(["laptop"]);
    expect(env.handlers.onError).not.toHaveBeenCalled();
  });

  it("stays on a working microphone when the new one fails to open", async () => {
    const env = setup({ chosen: "", systemDefault: "laptop" });
    await started(env);
    env.mediaDevices.getUserMedia.mockRejectedValueOnce(
      new DOMException("Gone again", "NotFoundError"),
    );

    env.state.systemDefault = "headset";
    env.devicesChanged();

    await vi.waitFor(() => expect(env.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2));
    expect(env.hearing()).toEqual(["laptop"]);
    expect(env.tracks[0]?.readyState).toBe("live");
    expect(env.handlers.onError).not.toHaveBeenCalled();
  });

  it("reports an error when the microphone is gone and none is left to move to", async () => {
    const env = setup({ chosen: "", systemDefault: "laptop" });
    await started(env);
    env.mediaDevices.getUserMedia.mockRejectedValueOnce(
      new DOMException("No device", "NotFoundError"),
    );

    env.tracks[0]?.disconnect();

    await vi.waitFor(() => expect(env.handlers.onError).toHaveBeenCalledOnce());
    expect(env.handlers.onError.mock.calls[0]?.[0].message).toContain("No microphone was found");
  });

  it("checks the microphone again once the detector has loaded", async () => {
    const late = setup({ chosen: "", systemDefault: "laptop" });
    // Unplugged while the detector loaded, before anything listened for it.
    late.mediaDevices.getUserMedia.mockImplementationOnce(async () => {
      const track = new FakeTrack("laptop");
      track.readyState = "ended";
      late.tracks.push(track);
      late.opened.push("default");
      return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
    });
    await late.source.start();

    await vi.waitFor(() => expect(late.opened).toEqual(["default", "default"]));
    expect(late.tracks[1]?.readyState).toBe("live");
  });

  it("closes a microphone that finishes opening after hang-up", async () => {
    const env = setup({ chosen: "", systemDefault: "laptop" });
    await started(env);
    let finishOpening: (() => void) | undefined;
    const late = new FakeTrack("headset");
    env.mediaDevices.getUserMedia.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOpening = () =>
            resolve({
              getAudioTracks: () => [late],
              getTracks: () => [late],
            } as unknown as MediaStream);
        }),
    );
    env.state.systemDefault = "headset";
    env.devicesChanged();
    await vi.waitFor(() => expect(finishOpening).toBeDefined());

    await env.source.stop();
    finishOpening?.();

    await vi.waitFor(() => expect(late.readyState).toBe("ended"));
    expect(env.tracks[0]?.readyState).toBe("ended");
    expect(env.hearing()).toEqual([]);
    expect(env.contexts[0]?.close).toHaveBeenCalledOnce();
  });

  it("stops following devices on hang-up", async () => {
    const env = setup({ chosen: "", systemDefault: "laptop" });
    await started(env);

    await env.source.stop();
    env.state.systemDefault = "headset";
    env.devicesChanged();

    expect(env.mediaDevices.enumerateDevices).toHaveBeenCalledOnce();
    expect(env.opened).toEqual(["default"]);
  });
});
