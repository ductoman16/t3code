"use strict";

// Ducked volume, as a fraction of the page's own.
const DUCKED_VOLUME = 0.2;
/** Each element turned down, with the volume it had and the volume it was given. */
const lowered = new Map();
let ducked = false;

function lower(media) {
  if (lowered.has(media)) return;
  const before = media.volume;
  media.volume = before * DUCKED_VOLUME;
  lowered.set(media, { before, given: media.volume });
}

function restore() {
  // An element whose volume changed while ducked was set by the page or the user; keep theirs.
  for (const [media, { before, given }] of lowered)
    if (media.volume === given) media.volume = before;
  lowered.clear();
}

function setDucked(next) {
  ducked = next;
  if (ducked) document.querySelectorAll("audio, video").forEach(lower);
  else restore();
}

// shortcut: misses media outside the document or in shadow roots, and Web Audio; hook HTMLMediaElement in the page if a site needs it.
document.addEventListener(
  "play",
  ({ target }) => {
    if (ducked && target instanceof HTMLMediaElement) lower(target);
  },
  true,
);

const extension = browser.runtime.connect();
extension.onMessage.addListener(setDucked);
// The extension was disabled, updated or crashed: nothing will say "restore" any more.
extension.onDisconnect.addListener(() => setDucked(false));
