// @effect-diagnostics nodeBuiltinImport:off - A bare loopback event stream; Firefox reads it with EventSource.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as DesktopIpc from "../DesktopIpc.ts";
import { SET_VOICE_AUDIO_DUCKING_CHANNEL } from "../channels.ts";

/** The address `firefox-audio-ducking/followDucking.js` reads; change both together. */
const AUDIO_DUCKING_PORT = 47_391;
export const AUDIO_DUCKING_PATH = "/voice-audio-ducking";
/** The extension restores audio when three of these pass without an event. */
const AUDIO_DUCKING_REPEAT = "5 seconds";

/**
 * Tells every listener on loopback whether voice mode wants other audio turned down, as a
 * server-sent event stream: once on connect, on each change, and repeated as a heartbeat.
 */
const serveAudioDucking = Effect.fn("desktop.voiceAudioDucking.serve")(function* (port: number) {
  const listeners = new Set<NodeHttp.ServerResponse>();
  let ducked = false;
  const tell = (listener: NodeHttp.ServerResponse) =>
    listener.write(`data: ${ducked ? "duck" : "restore"}\n\n`);

  const server = yield* Effect.acquireRelease(
    Effect.callback<NodeHttp.Server, Error>((resume) => {
      const server = NodeHttp.createServer((request, response) => {
        if (request.method !== "GET" || request.url !== AUDIO_DUCKING_PATH) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
        });
        listeners.add(response);
        tell(response);
        request.on("close", () => listeners.delete(response));
      });
      server.once("error", (error) => resume(Effect.fail(error)));
      server.listen(port, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        for (const listener of listeners) listener.end();
        server.close(() => resume(Effect.void));
      }),
  );

  yield* Effect.sync(() => listeners.forEach(tell)).pipe(
    Effect.repeat(Schedule.spaced(AUDIO_DUCKING_REPEAT)),
    Effect.forkScoped,
  );

  return {
    port: (server.address() as NodeNet.AddressInfo).port,
    setDucked: (next: boolean) => {
      if (next === ducked) return;
      ducked = next;
      listeners.forEach(tell);
    },
  };
});

/** Ducks while any app window asks to, and stops when that window reloads, crashes or closes. */
export const installVoiceAudioDucking = Effect.fn("desktop.ipc.installVoiceAudioDucking")(
  function* (port: number = AUDIO_DUCKING_PORT) {
    const ipc = yield* DesktopIpc.DesktopIpc;
    const broadcast = yield* serveAudioDucking(port).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `Firefox audio ducking is off: T3 Code could not listen on 127.0.0.1:${port} ("${error.message}"). Quit whatever else holds that port and restart T3 Code.`,
        ).pipe(Effect.as(null)),
      ),
    );

    const ducking = new Set<number>();
    const watched = new Set<number>();
    const update = () => broadcast?.setDucked(ducking.size > 0);
    const watch = (id: number) => {
      const contents = Electron.webContents.fromId(id);
      if (!contents || watched.has(id)) return;
      watched.add(id);
      const release = () => {
        ducking.delete(id);
        update();
      };
      contents.on("did-navigate", release);
      contents.on("render-process-gone", release);
      contents.once("destroyed", () => {
        watched.delete(id);
        release();
      });
    };

    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: SET_VOICE_AUDIO_DUCKING_CHANNEL,
        payload: Schema.Boolean,
        result: Schema.Void,
        handler: (ducked, event) =>
          Effect.sync(() => {
            if (!event) return;
            const id = event.sender.id;
            watch(id);
            if (ducked && watched.has(id)) ducking.add(id);
            else ducking.delete(id);
            update();
          }),
      }),
    );
  },
);
