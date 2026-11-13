import { describe, expect, it } from "vite-plus/test";

import { createSpeechChunker } from "./speakableText";

/** Feeds the reply one character at a time, the worst case for streaming. */
function speakStreamed(reply: string): string[] {
  const chunker = createSpeechChunker();
  const spoken: string[] = [];
  for (let length = 1; length <= reply.length; length += 1) {
    spoken.push(...chunker.push(reply.slice(0, length)));
  }
  spoken.push(...chunker.finish(reply));
  return spoken;
}

describe("createSpeechChunker", () => {
  it("releases each sentence as soon as the next one begins", () => {
    const chunker = createSpeechChunker();

    expect(chunker.push("I found the bug.")).toEqual([]);
    expect(chunker.push("I found the bug. It")).toEqual(["I found the bug."]);
    expect(chunker.push("I found the bug. It is in the parser")).toEqual([]);
    expect(chunker.finish("I found the bug. It is in the parser")).toEqual(["It is in the parser"]);
  });

  it("says the same thing however the reply is split into deltas", () => {
    const reply = "First point. Second point!\n\nThird point? Yes.";

    expect(speakStreamed(reply)).toEqual(["First point.", "Second point!", "Third point?", "Yes."]);
  });

  it("leaves out code blocks, including one still streaming", () => {
    const reply = "Here is the fix:\n```ts\nconst a = 1. Then\n```\nIt passes now.";

    expect(speakStreamed(reply)).toEqual(["Here is the fix:", "It passes now."]);
    const chunker = createSpeechChunker();
    expect(chunker.push("Run this:\n```sh\nnpm test. Done")).toEqual(["Run this:"]);
  });

  it("reads markdown as plain words", () => {
    const reply = [
      "## Summary",
      "- **Fixed** the `parseDate` helper.",
      "1. See [the docs](https://example.com/docs) for details.",
      "> Quoted *note* here.",
      "Visit https://example.com/a?b=c now.",
    ].join("\n");

    expect(speakStreamed(reply)).toEqual([
      "Summary",
      "Fixed the parseDate helper.",
      "See the docs for details.",
      "Quoted note here.",
      "Visit now.",
    ]);
  });

  it("leaves out tables and rules", () => {
    const reply = "Results:\n| File | Status |\n| --- | --- |\n| a.ts | ok |\n---\nAll good.";

    expect(speakStreamed(reply)).toEqual(["Results:", "All good."]);
  });

  it("keeps abbreviations and decimals inside their sentence", () => {
    expect(speakStreamed("Use a cache, e.g. the 2.5 MB one. Then retry.")).toEqual([
      "Use a cache, e.g. the 2.5 MB one.",
      "Then retry.",
    ]);
  });

  it("does not cut a sentence inside an unfinished link or code span", () => {
    const chunker = createSpeechChunker();

    expect(chunker.push("See [the guide. It")).toEqual([]);
    expect(chunker.push("Call `a.b. C")).toEqual([]);
  });

  it("splits a very long sentence at its clauses", () => {
    const clause = "this clause is about forty characters long";
    const sentence = `${Array.from({ length: 12 }, () => clause).join(", ")}.`;

    const spoken = speakStreamed(sentence);

    expect(spoken.length).toBeGreaterThan(1);
    expect(spoken.every((piece) => piece.length <= 280)).toBe(true);
    expect(spoken.join(" ")).toBe(sentence);
  });

  it("says nothing for a reply with no words", () => {
    expect(speakStreamed("```\ncode only\n```\n---\n")).toEqual([]);
  });
});
