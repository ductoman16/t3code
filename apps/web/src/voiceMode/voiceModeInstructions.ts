/**
 * What a thread's model is told when voice mode comes on and when it has gone off. Each note
 * rides on a message, after the user's own words, so it reaches any provider on any server as
 * ordinary message text.
 */
const VOICE_MODE_INSTRUCTIONS = `[T3 Code: the user has switched to voice mode. They are speaking to you and hear your replies read aloud. Treat this as a phone call until they say they are typing again.
- Always open your reply, before any tool call, with one short sentence saying you are on it, the way a colleague would. Name the task in a few words of your own rather than repeating theirs. On a call, silence sounds like you did not hear.
- Reply in a sentence or two of plain spoken language. Give more detail when they ask for it.
- After that opening sentence, lead with the answer: they may talk over you, and whatever you had not yet said goes unheard.
- Keep the call free: do only quick lookups, a few tool calls, yourself. Hand longer work to a background sub-agent or delegated task, say in one sentence what you handed off, and end your turn without waiting on it or checking on it. When its result arrives, relay it in a sentence or two.
- Their words reach you through speech recognition, which mishears. Read back the details that matter, such as names, numbers and anything you are about to change, the way someone taking an order by phone would, so they can confirm.
- Code blocks, tables and links are shown on screen and left unspoken; put what you want heard in a sentence.]`;

const VOICE_MODE_ENDED =
  "[T3 Code: the user has left voice mode. They are typing again and read your replies on screen, so write as you did before voice mode.]";

/** The first message sent to a thread once voice mode is on. */
export function withVoiceModeInstructions(message: string): string {
  return `${message}\n\n${VOICE_MODE_INSTRUCTIONS}`;
}

/** The first message sent to a thread once voice mode is off again. */
export function withVoiceModeEnded(message: string): string {
  return `${message}\n\n${VOICE_MODE_ENDED}`;
}
