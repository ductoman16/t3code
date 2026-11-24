import { describe, expect, it } from "vite-plus/test";

import { createReplyReader, type TimelineItem } from "./replyReader.ts";

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
      onMessageQueued: () => {},
      isMessageCutOff: () => false,
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

    const first = assistant("a1", "I found the cause. I haven’t verified dev", true);
    const second = assistant("a2", "The service is responsive.");
    const third = assistant("a3", "I recommend reserving memory.");
    reader.read([first]);
    reader.read([first, second]);
    reader.read([first, second, third]);
    expect(events).toEqual(["a1: I found the cause."]);

    reader.read([assistant("a1", "I found the cause. I haven’t verified dev"), second, third]);

    expect(events).toEqual([
      "a1: I found the cause.",
      "a1: I haven’t verified dev",
      "a1 ended",
      "a2: The service is responsive.",
      "a2 ended",
      "a3: I recommend reserving memory.",
      "a3 ended",
    ]);
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

  it("keeps queued messages in order after they leave the discovery window", () => {
    const { events, reader } = setUp();
    const first = assistant("a1", "Still thinking", true);
    const second = assistant("a2", "Next reply.");
    const tools = Array.from({ length: 40 }, (_, index) =>
      other(`tool-${index}`, "command_execution"),
    );
    reader.read([]);
    reader.read([first, second]);
    reader.read([first, second, ...tools]);
    expect(events).toEqual([]);

    reader.read([assistant("a1", "Still thinking. Ready now."), second, ...tools]);
    expect(events).toEqual([
      "a1: Still thinking.",
      "a1: Ready now.",
      "a1 ended",
      "a2: Next reply.",
      "a2 ended",
    ]);
  });

  it("reports the end of a message that disappears while streaming", () => {
    const { events, reader } = setUp();
    reader.read([]);
    reader.read([assistant("a1", "I am about to", true)]);

    const second = assistant("a2", "Next reply.");
    reader.read([assistant("a1", "I am about to", true), second]);
    reader.read([second]);

    expect(events).toEqual(["a1 ended", "a2: Next reply.", "a2 ended"]);
  });
});
