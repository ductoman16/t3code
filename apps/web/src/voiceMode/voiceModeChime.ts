import { VOICE_MODE_CHIME, type VoiceModeChime } from "@t3tools/client-runtime/voice-mode";

/**
 * Plays a chime on its own audio context, closed once the last note ends. It runs inside voice
 * mode's state listeners, so a device that cannot play it must not throw into them.
 */
export function playVoiceModeChime(chime: VoiceModeChime): void {
  try {
    const context = new AudioContext();
    void context.resume().catch(() => undefined);
    const { notesHz, noteMs, attackMs, releaseMs, peak } = VOICE_MODE_CHIME;
    const notes = notesHz[chime];
    const note = noteMs / 1000;
    const begin = context.currentTime + 0.02;
    notes.forEach((frequency, index) => {
      const at = begin + index * note;
      const tone = new OscillatorNode(context, { type: "sine", frequency });
      const envelope = new GainNode(context, { gain: 0 });
      // Ramps in and out, so the notes start and end without a click.
      envelope.gain.setValueAtTime(0, at);
      envelope.gain.linearRampToValueAtTime(peak, at + attackMs / 1000);
      envelope.gain.setValueAtTime(peak, at + note - releaseMs / 1000);
      envelope.gain.linearRampToValueAtTime(0, at + note);
      tone.connect(envelope).connect(context.destination);
      tone.start(at);
      tone.stop(at + note);
      if (index === notes.length - 1) tone.onended = () => void context.close();
    });
  } catch (error) {
    console.warn("Could not play the voice mode chime.", error);
  }
}
