import { describe, expect, it } from "vite-plus/test";

import { createReplyReader, type TimelineItem } from "./replyReader";

const assistant = (id: string, text: string, streaming = false): TimelineItem => ({
  item: { id, type: "assistant_message", text, streaming },
});
const other = (id: string, type: string, text = ""): TimelineItem => ({
  item: { id, type, text, streaming: true },
});

function setUp(options = { includeReplyInProgress: false }) {
  const events: string[] = [];
  const reader = createReplyReader(
    {
      onSentence: (messageId, sentence) => events.push(`${messageId}: ${sentence}`),
      onMessageEnd: (messageId) => events.push(`${messageId} ended`),
    },
    options,
  );
  return { events, reader };
}

describe("createReplyReader", () => {
  it("stays silent about messages already in the thread", () => {
    const { events, reader } = setUp();

    reader.read([assistant("a1", "Old answer."), assistant("a2", "Another old answer.")]);

    expect(events).toEqual([]);
  });

  it("reads a new message sentence by sentence as it streams, then reports its end", () => {
    const { events, reader } = setUp();
    const history = [assistant("a1", "Old answer.")];
    reader.read(history);

    reader.read([...history, assistant("a2", "I found", true)]);
    reader.read([...history, assistant("a2", "I found the bug. It is", true)]);
    reader.read([...history, assistant("a2", "I found the bug. It is fixed", false)]);

    expect(events).toEqual(["a2: I found the bug.", "a2: It is fixed", "a2 ended"]);
  });

  it("reads a message that arrives already complete", () => {
    const { events, reader } = setUp();
    reader.read([]);

    reader.read([assistant("a1", "Done. All tests pass.")]);

    expect(events).toEqual(["a1: Done.", "a1: All tests pass.", "a1 ended"]);
  });

  it("reads only the agent's messages, not its reasoning or tool calls", () => {
    const { events, reader } = setUp();
    reader.read([]);

    reader.read([
      other("r1", "reasoning", "The user wants the tests run."),
      other("c1", "command_execution"),
      assistant("a1", "Running them now.", true),
    ]);
    reader.read([
      other("r1", "reasoning", "The user wants the tests run."),
      other("c1", "command_execution"),
      assistant("a1", "Running them now.", false),
    ]);

    expect(events).toEqual(["a1: Running them now.", "a1 ended"]);
  });

  it("reads each of a turn's messages in order", () => {
    const { events, reader } = setUp();
    reader.read([]);

    reader.read([assistant("a1", "Looking at the parser.")]);
    reader.read([
      assistant("a1", "Looking at the parser."),
      other("c1", "command_execution"),
      assistant("a2", "Fixed it.", true),
    ]);
    reader.read([
      assistant("a1", "Looking at the parser."),
      other("c1", "command_execution"),
      assistant("a2", "Fixed it.", false),
    ]);

    expect(events).toEqual(["a1: Looking at the parser.", "a1 ended", "a2: Fixed it.", "a2 ended"]);
  });

  it("stays silent about a message streaming when reading began, unless asked to include it", () => {
    const silent = setUp({ includeReplyInProgress: false });
    silent.reader.read([assistant("a1", "Half an answer. More", true)]);
    silent.reader.read([assistant("a1", "Half an answer. More to come.", false)]);
    expect(silent.events).toEqual([]);

    const included = setUp({ includeReplyInProgress: true });
    included.reader.read([assistant("a1", "Half an answer. More", true)]);
    included.reader.read([assistant("a1", "Half an answer. More to come.", false)]);
    expect(included.events).toEqual(["a1: Half an answer.", "a1: More to come.", "a1 ended"]);
  });

  it("stays silent about older history loaded later", () => {
    const { events, reader } = setUp();
    reader.read([assistant("a5", "Recent answer.")]);

    reader.read([assistant("a3", "Older answer."), assistant("a5", "Recent answer.")]);

    expect(events).toEqual([]);
  });

  it("reports the end of a message that disappears while streaming", () => {
    const { events, reader } = setUp();
    reader.read([]);
    reader.read([assistant("a1", "I am about to", true)]);

    reader.read([]);

    expect(events).toEqual(["a1 ended"]);
  });
});
