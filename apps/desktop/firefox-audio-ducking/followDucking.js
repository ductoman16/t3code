/** Served by the T3 Code (Voice) desktop app: `apps/desktop/src/ipc/methods/voiceAudioDucking.ts`. */
export const DUCKING_URL = "http://127.0.0.1:47391/voice-audio-ducking";
// T3 Code repeats its state every 5 seconds, so this much silence means it is gone or hung.
export const STALE_MS = 15_000;

/**
 * Follows T3 Code's ducking events and reports each change to `onChange`. Anything short of a
 * live connection saying "duck" restores the audio, and a silent connection is replaced.
 */
export function followDucking({ open, onChange }) {
  let ducked = false;
  let events;
  let stale;
  const set = (next) => {
    if (next === ducked) return;
    ducked = next;
    onChange(next);
  };
  const expectEvent = () => {
    clearTimeout(stale);
    stale = setTimeout(() => {
      events.close();
      set(false);
      connect();
    }, STALE_MS);
  };
  const connect = () => {
    events = open(DUCKING_URL);
    events.onmessage = ({ data }) => {
      expectEvent();
      set(data === "duck");
    };
    events.onerror = () => set(false);
    expectEvent();
  };
  connect();
}
