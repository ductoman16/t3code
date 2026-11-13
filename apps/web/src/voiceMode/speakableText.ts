/**
 * Turns an assistant reply into sentences worth saying aloud, as the reply streams.
 *
 * Code blocks, tables and URLs are left out: read aloud they are noise, and the text is on screen.
 */

// Kokoro truncates long inputs, and a shorter first sentence is heard sooner.
const MAX_SENTENCE_CHARACTERS = 280;

const FENCE = /^\s{0,3}(```|~~~)/;
const TABLE_ROW = /^\s*\|/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
// A terminator followed by a new sentence. A lowercase letter next means an abbreviation ("e.g. the").
const SENTENCE_END = /[.!?]+["'”’)\]]*\s+(?=[^\sa-z])/g;
const CLAUSE_END = /[,;:—–]\s+/g;

function cleanLine(line: string): string {
  return (
    line
      // Block markers: headings, quotes, bullets and numbered items.
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^(\s*>)+\s?/, "")
      .replace(/^\s*([-*+]|\d{1,3}[.)])\s+(\[[ xX]\]\s+)?/, "")
      // Images say nothing; links say their label.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<https?:\/\/[^>\s]+>/g, "")
      .replace(/https?:\/\/[^\s)]+/g, "")
      .replace(/<\/?[a-zA-Z][^>]*>/g, "")
      // Emphasis and inline code keep their words.
      .replace(/(\*\*|__|~~)/g, "")
      .replace(/(^|[\s(])[*_]([^*_\s][^*_]*)[*_](?=$|[\s).,!?;:])/g, "$1$2")
      .replace(/`+/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function hasWords(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

function splitAt(text: string, boundary: RegExp): string[] {
  const parts: string[] = [];
  let start = 0;
  for (const match of text.matchAll(boundary)) {
    const end = match.index + match[0].length;
    parts.push(text.slice(start, end));
    start = end;
  }
  parts.push(text.slice(start));
  return parts;
}

function splitLongSentence(sentence: string): string[] {
  if (sentence.length <= MAX_SENTENCE_CHARACTERS) return [sentence];
  const pieces: string[] = [];
  let current = "";
  for (const clause of splitAt(sentence, CLAUSE_END)) {
    if (current && current.length + clause.length > MAX_SENTENCE_CHARACTERS) {
      pieces.push(current);
      current = "";
    }
    current += clause;
    // A clause with no punctuation to split at is cut between words.
    while (current.length > MAX_SENTENCE_CHARACTERS) {
      const space = current.lastIndexOf(" ", MAX_SENTENCE_CHARACTERS);
      const cut = space > 0 ? space : MAX_SENTENCE_CHARACTERS;
      pieces.push(current.slice(0, cut));
      current = current.slice(cut);
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function sentencesOf(text: string): string[] {
  return splitAt(text, SENTENCE_END)
    .flatMap(splitLongSentence)
    .map((sentence) => sentence.trim())
    .filter(hasWords);
}

export interface SpeechChunker {
  /** Takes the whole reply so far and returns the sentences completed since the last call. */
  push(text: string): string[];
  /** Returns whatever is left once the reply has finished. */
  finish(text: string): string[];
}

export function createSpeechChunker(): SpeechChunker {
  let offset = 0;
  let inFence = false;

  const readLine = (line: string): string[] => {
    if (FENCE.test(line)) {
      inFence = !inFence;
      return [];
    }
    if (inFence || TABLE_ROW.test(line) || RULE.test(line)) return [];
    return sentencesOf(cleanLine(line));
  };

  const readCompleteLines = (text: string): string[] => {
    const sentences: string[] = [];
    for (
      let newline = text.indexOf("\n", offset);
      newline !== -1;
      newline = text.indexOf("\n", offset)
    ) {
      sentences.push(...readLine(text.slice(offset, newline)));
      offset = newline + 1;
    }
    return sentences;
  };

  return {
    push(text) {
      const sentences = readCompleteLines(text);
      const tail = text.slice(offset);
      // An unfinished line that may yet turn out to be a fence or a table row waits for its newline.
      if (inFence || /^\s*[`~|]/.test(tail)) return sentences;
      let end = 0;
      for (const match of tail.matchAll(SENTENCE_END)) end = match.index + match[0].length;
      // A link or code span still open at the cut would be read as its raw markup.
      const head = tail.slice(0, end);
      if (
        end === 0 ||
        (head.match(/`/g)?.length ?? 0) % 2 === 1 ||
        /\[[^\]]*$|\]\([^)]*$/.test(head)
      )
        return sentences;
      offset += end;
      // Block markers belong to the start of the line, which this may no longer be.
      sentences.push(...sentencesOf(cleanLine(head)));
      return sentences;
    },
    finish(text) {
      const sentences = readCompleteLines(text);
      sentences.push(...readLine(text.slice(offset)));
      offset = text.length;
      return sentences;
    },
  };
}
