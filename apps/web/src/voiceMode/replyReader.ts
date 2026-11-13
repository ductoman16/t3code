import { createSpeechChunker, type SpeechChunker } from "./speakableText";
import type { ReplyHandlers } from "./voiceModeController";

/** The part of a thread's timeline item that reading replies depends on. */
export interface TimelineItem {
  readonly item: {
    readonly id: string;
    readonly type: string;
    readonly text?: string;
    readonly streaming?: boolean;
  };
}

// A reply being read is among the newest items; older ones are not searched on every text delta.
const NEWEST_ITEMS = 40;

interface AssistantMessage {
  readonly id: string;
  readonly text: string;
  readonly streaming: boolean;
}

function assistantMessages(items: ReadonlyArray<TimelineItem>): AssistantMessage[] {
  return items.flatMap(({ item }) =>
    item.type === "assistant_message"
      ? [{ id: item.id, text: item.text ?? "", streaming: item.streaming === true }]
      : [],
  );
}

/**
 * Follows a thread's timeline and reports each new agent message as speakable sentences.
 *
 * Only the agent's own messages are read: not its reasoning, tool calls or command output.
 * Messages already in the thread when reading begins are history and stay silent.
 */
export function createReplyReader(
  handlers: ReplyHandlers,
  options: { readonly includeReplyInProgress: boolean },
) {
  const seen = new Set<string>();
  const reading = new Map<string, SpeechChunker>();
  let started = false;

  const begin = (message: AssistantMessage) => {
    seen.add(message.id);
    reading.set(message.id, createSpeechChunker());
  };

  return {
    /** Takes the thread's whole timeline each time it changes. */
    read(items: ReadonlyArray<TimelineItem>): void {
      if (!started) {
        started = true;
        for (const message of assistantMessages(items)) {
          if (message.streaming && options.includeReplyInProgress) begin(message);
          else seen.add(message.id);
        }
      }
      const newest = assistantMessages(items.slice(-NEWEST_ITEMS));
      // A new reply comes after everything already seen. An unseen message before a seen one is
      // older history that has just been loaded.
      let firstNew = newest.length;
      while (firstNew > 0 && !seen.has(newest[firstNew - 1]!.id)) firstNew -= 1;
      newest.slice(firstNew).forEach(begin);
      for (const message of newest) seen.add(message.id);

      for (const [id, chunker] of reading) {
        const message = newest.find((candidate) => candidate.id === id);
        if (message) {
          for (const sentence of chunker.push(message.text)) handlers.onSentence(id, sentence);
          if (message.streaming) continue;
          for (const sentence of chunker.finish(message.text)) handlers.onSentence(id, sentence);
        }
        // Finished, or gone from the timeline: either way nothing more of it will be said.
        reading.delete(id);
        handlers.onMessageEnd(id);
      }
    },
  };
}
