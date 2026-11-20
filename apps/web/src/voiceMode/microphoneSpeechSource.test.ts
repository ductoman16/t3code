import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createMicrophoneSpeechSource } from "./microphoneSpeechSource";

interface FakeDetectorOptions {
  readonly getStream: () => Promise<MediaStream>;
  readonly resumeStream: (stream: MediaStream) => Promise<MediaStream>;
  readonly onSpeechEnd: (audio: Float32Array) => void;
}

// Stands in for MicVAD: opens a stream when created, closes it on pause, opens another on start,
// and sends the phrase in progress when paused, as `submitUserSpeechOnPause` does.
const detector = vi.hoisted(() => ({ speaking: false }));
vi.mock("@ricky0123/vad-web", () => ({
  MicVAD: {
    async new(options: FakeDetectorOptions) {
      let stream = await options.getStream();
      let submitOnPause = true;
      const instance = {
        setOptions: vi.fn((update: { submitUserSpeechOnPause?: boolean }) => {
          submitOnPause = update.submitUserSpeechOnPause ?? submitOnPause;
        }),
        async pause() {
          for (const track of stream.getTracks()) track.stop();
          if (detector.speaking && submitOnPause) options.onSpeechEnd(new Float32Array(1));
          detector.speaking = false;
        },
        async start() {
          stream = await options.resumeStream(stream);
        },
        async destroy() {
          await instance.pause();
        },
      };
      return instance;
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

function setup(initial: { chosen: string; systemDefault: string }) {
  const state = { ...initial };
  const devices = new EventTarget();
  const tracks: FakeTrack[] = [];
  const opened: Array<MediaStreamConstraints> = [];
  const mediaDevices = Object.assign(devices, {
    getUserMedia: vi.fn(async (constraints: MediaStreamConstraints) => {
      opened.push(constraints);
      const audio = constraints.audio as MediaTrackConstraints;
      const exact = (audio.deviceId as { exact?: string } | undefined)?.exact;
      const track = new FakeTrack(exact ?? state.systemDefault);
      tracks.push(track);
      return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
    }),
    enumerateDevices: vi.fn(async () => [
      { kind: "audioinput", deviceId: "default", groupId: state.systemDefault },
    ]),
  });
  vi.stubGlobal("navigator", { mediaDevices });
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
  return { state, source, handlers, tracks, opened, mediaDevices, devicesChanged };
}

const deviceIds = (opened: Array<MediaStreamConstraints>) =>
  opened.map(
    (constraints) =>
      ((constraints.audio as MediaTrackConstraints).deviceId as { exact?: string } | undefined)
        ?.exact ?? "default",
  );

beforeEach(() => {
  detector.speaking = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createMicrophoneSpeechSource", () => {
  it("moves the call to headphones that become the system default", async () => {
    const { state, source, tracks, opened, devicesChanged } = setup({
      chosen: "",
      systemDefault: "laptop",
    });
    await source.start();

    state.systemDefault = "headset";
    devicesChanged();

    await vi.waitFor(() => expect(deviceIds(opened)).toEqual(["default", "default"]));
    expect(tracks.map((track) => [track.groupId, track.readyState])).toEqual([
      ["laptop", "ended"],
      ["headset", "live"],
    ]);
  });

  it("moves to the microphone Settings → Voice's order picks once it connects", async () => {
    const { state, source, opened, devicesChanged } = setup({
      chosen: "",
      systemDefault: "laptop",
    });
    await source.start();

    state.chosen = "headset";
    devicesChanged();

    await vi.waitFor(() => expect(deviceIds(opened)).toEqual(["default", "headset"]));
  });

  it("keeps the microphone when a change does not affect it", async () => {
    const { state, source, opened, mediaDevices, devicesChanged } = setup({
      chosen: "",
      systemDefault: "laptop",
    });
    await source.start();

    devicesChanged();
    await vi.waitFor(() => expect(mediaDevices.enumerateDevices).toHaveBeenCalledOnce());
    state.systemDefault = "headset";
    devicesChanged();

    // Only the second change, which did affect it, reopened the microphone.
    await vi.waitFor(() => expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(deviceIds(opened)).toEqual(["default", "default"]));
  });

  it("sends the phrase in progress when the microphone changes", async () => {
    const { state, source, handlers, devicesChanged } = setup({
      chosen: "",
      systemDefault: "laptop",
    });
    await source.start();
    detector.speaking = true;

    state.systemDefault = "headset";
    devicesChanged();

    await vi.waitFor(() => expect(handlers.onUtterance).toHaveBeenCalledOnce());
  });

  it("moves to the next microphone when the one in use is unplugged", async () => {
    const { state, source, handlers, tracks, opened } = setup({
      chosen: "headset",
      systemDefault: "laptop",
    });
    await source.start();

    state.chosen = "";
    tracks[0]?.disconnect();

    await vi.waitFor(() => expect(deviceIds(opened)).toEqual(["headset", "default"]));
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it("reports an error when no microphone is left to move to", async () => {
    const { state, source, handlers, tracks } = setup({ chosen: "", systemDefault: "laptop" });
    await source.start();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(
      new DOMException("No device", "NotFoundError"),
    );

    state.systemDefault = "";
    tracks[0]?.disconnect();

    await vi.waitFor(() => expect(handlers.onError).toHaveBeenCalledOnce());
    expect(handlers.onError.mock.calls[0]?.[0].message).toContain("No microphone was found");
  });

  it("drops the phrase in progress and stops following devices on hang-up", async () => {
    const { state, source, handlers, opened, mediaDevices, devicesChanged } = setup({
      chosen: "",
      systemDefault: "laptop",
    });
    await source.start();
    detector.speaking = true;

    await source.stop();
    state.systemDefault = "headset";
    devicesChanged();

    expect(handlers.onUtterance).not.toHaveBeenCalled();
    expect(mediaDevices.enumerateDevices).not.toHaveBeenCalled();
    expect(deviceIds(opened)).toEqual(["default"]);
  });
});
