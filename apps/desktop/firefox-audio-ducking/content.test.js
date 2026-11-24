import { expect, it, vi } from "vite-plus/test";

import source from "./content.js?raw";

/** Runs the real content script in this document, connected to a fake extension. */
function setup() {
  const listeners = { message: [], disconnect: [] };
  vi.stubGlobal("browser", {
    runtime: {
      connect: () => ({
        onMessage: { addListener: (listener) => listeners.message.push(listener) },
        onDisconnect: { addListener: (listener) => listeners.disconnect.push(listener) },
      }),
    },
  });
  new Function(source)();
  document.body.replaceChildren();
  const media = (tag, volume) => {
    const element = document.createElement(tag);
    element.volume = volume;
    document.body.append(element);
    return element;
  };
  return {
    media,
    send: (ducked) => listeners.message.forEach((listener) => listener(ducked)),
    disconnect: () => listeners.disconnect.forEach((listener) => listener()),
    [Symbol.dispose]: () => {
      listeners.disconnect.forEach((listener) => listener());
      vi.unstubAllGlobals();
    },
  };
}

it("turns every audio and video element down, then back to where each was", () => {
  using page = setup();
  const music = page.media("audio", 0.8);
  const video = page.media("video", 1);
  page.send(true);
  expect(music.volume).toBeCloseTo(0.16);
  expect(video.volume).toBeCloseTo(0.2);
  page.send(true);
  expect(music.volume).toBeCloseTo(0.16);
  page.send(false);
  expect(music.volume).toBe(0.8);
  expect(video.volume).toBe(1);
});

it("turns down media that starts playing while ducked", () => {
  using page = setup();
  page.send(true);
  const late = page.media("audio", 0.5);
  late.dispatchEvent(new Event("play"));
  expect(late.volume).toBeCloseTo(0.1);
  page.send(false);
  expect(late.volume).toBe(0.5);
  late.dispatchEvent(new Event("play"));
  expect(late.volume).toBe(0.5);
});

it("keeps a volume the page or the user chose while ducked", () => {
  using page = setup();
  const music = page.media("audio", 0.8);
  page.send(true);
  music.volume = 0.6;
  page.send(false);
  expect(music.volume).toBe(0.6);
});

it("restores when the extension goes away", () => {
  using page = setup();
  const music = page.media("audio", 0.8);
  page.send(true);
  page.disconnect();
  expect(music.volume).toBe(0.8);
});
