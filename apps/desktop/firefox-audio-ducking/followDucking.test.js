import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { DUCKING_URL, followDucking, STALE_MS } from "./followDucking.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function follow() {
  const connections = [];
  const changes = [];
  followDucking({
    open: (url) => {
      const connection = { url, closed: false, close: () => (connection.closed = true) };
      connections.push(connection);
      return connection;
    },
    onChange: (ducked) => changes.push(ducked),
  });
  const latest = () => connections.at(-1);
  const say = (data) => latest().onmessage({ data });
  return { connections, changes, latest, say };
}

it("ducks on T3 Code's say-so and reports only changes", () => {
  const { connections, changes, say } = follow();
  expect(connections.map((connection) => connection.url)).toEqual([DUCKING_URL]);
  say("restore");
  say("duck");
  say("duck");
  say("restore");
  expect(changes).toEqual([true, false]);
});

it("restores when the connection fails", () => {
  const { changes, latest, say } = follow();
  say("duck");
  latest().onerror();
  expect(changes).toEqual([true, false]);
});

it("restores and reconnects when T3 Code goes quiet, as a hung app does", () => {
  const { connections, changes, say } = follow();
  say("duck");
  vi.advanceTimersByTime(STALE_MS - 1);
  say("duck");
  vi.advanceTimersByTime(STALE_MS - 1);
  expect(changes).toEqual([true]);
  vi.advanceTimersByTime(1);
  expect(changes).toEqual([true, false]);
  expect(connections).toHaveLength(2);
  expect(connections[0].closed).toBe(true);
  say("duck");
  expect(changes).toEqual([true, false, true]);
});
