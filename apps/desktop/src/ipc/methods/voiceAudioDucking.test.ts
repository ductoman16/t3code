// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Reads the real loopback stream as the Firefox extension does.
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as Effect from "effect/Effect";
import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";

const windows = vi.hoisted(() => new Map<number, import("node:events").EventEmitter>());
vi.mock("electron", () => ({ webContents: { fromId: (id: number) => windows.get(id) } }));

import * as DesktopIpc from "../DesktopIpc.ts";
import { AUDIO_DUCKING_PATH, installVoiceAudioDucking } from "./voiceAudioDucking.ts";

/** Reads the event stream a Firefox profile would, one `data:` line at a time. */
async function listen(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}${AUDIO_DUCKING_PATH}`);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  return {
    contentType: response.headers.get("content-type"),
    next: async () => (await reader.read()).value,
    close: () => reader.cancel(),
  };
}

function freePort() {
  return new Promise<number>((resolve) => {
    const server = NodeHttp.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as NodeNet.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

const install = (port: number) => {
  const handlers = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
  return {
    handlers,
    run: <A, E>(test: Effect.Effect<A, E>) =>
      Effect.scoped(Effect.andThen(installVoiceAudioDucking(port), test)).pipe(
        Effect.provide(
          DesktopIpc.layerTest({
            handle: (channel, handler) => handlers.set(channel, handler),
            removeHandler: (channel) => handlers.delete(channel),
            on: vi.fn(),
            removeAllListeners: vi.fn(),
          }),
        ),
      ),
  };
};

it.live("ducks while a window asks to and restores when it reloads, crashes or closes", () =>
  Effect.gen(function* () {
    windows.clear();
    windows.set(1, new NodeEvents.EventEmitter());
    windows.set(2, new NodeEvents.EventEmitter());
    const port = yield* Effect.promise(freePort);
    const { handlers, run } = install(port);
    yield* run(
      Effect.promise(async () => {
        const set = (id: number, ducked: unknown) =>
          handlers.get("desktop:set-voice-audio-ducking")!({ sender: { id } }, ducked);
        const firefox = await listen(port);
        expect(firefox.contentType).toBe("text/event-stream");
        expect(await firefox.next()).toBe("data: restore\n\n");

        await expect(set(1, "yes")).rejects.toBeDefined();
        await set(1, true);
        expect(await firefox.next()).toBe("data: duck\n\n");
        await set(2, true);
        await set(1, false);
        windows.get(2)!.emit("did-navigate");
        expect(await firefox.next()).toBe("data: restore\n\n");

        const late = await listen(port);
        await set(2, true);
        expect(await late.next()).toBe("data: restore\n\n");
        expect(await late.next()).toBe("data: duck\n\n");
        windows.get(2)!.emit("render-process-gone");
        expect(await late.next()).toBe("data: restore\n\n");
        await set(1, true);
        expect(await late.next()).toBe("data: duck\n\n");
        windows.get(1)!.emit("destroyed");
        expect(await late.next()).toBe("data: restore\n\n");
        await firefox.close();
        await late.close();
      }),
    );
    expect(handlers.size).toBe(0);
    yield* Effect.promise(() => expect(listen(port)).rejects.toBeDefined());
  }),
);

it.live("keeps voice mode working when the port is taken", () =>
  Effect.gen(function* () {
    const taken = NodeHttp.createServer();
    yield* Effect.promise(
      () => new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve)),
    );
    const { port } = taken.address() as NodeNet.AddressInfo;
    const { handlers, run } = install(port);
    yield* run(
      Effect.promise(async () => {
        await handlers.get("desktop:set-voice-audio-ducking")!({ sender: { id: 1 } }, true);
      }),
    );
    yield* Effect.promise(() => new Promise((resolve) => taken.close(resolve)));
  }),
);
