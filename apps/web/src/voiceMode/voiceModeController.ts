/**
 * Voice mode: a spoken conversation with the thread's own agent. Speech is transcribed into the
 * composer draft and sent after a pause, so it reaches the thread's model exactly as typed text
 * would; the reply is read aloud as it streams, and talking over it cuts it off. A thread's model
 * is told when voice mode comes on, and when it has gone off, by a note on the user's next message.
 */
import * as Schema from "effect/Schema";

import { withVoiceModeEnded, withVoiceModeInstructions } from "./voiceModeInstructions";

export type VoiceModeActivity = "listening" | "hearing" | "transcribing" | "sending" | "speaking";

export interface VoiceModeState {
  readonly power: "off" | "starting" | "on";
  /** What voice mode is doing; only meaningful while it is on. */
  readonly activity: VoiceModeActivity;
  /** Progress, from 0 to 1, of a speech model download that is holding up the start. */
  readonly downloading: number | null;
  /** Why voice mode turned itself off. */
  readonly error: string | null;
  /** Something that went wrong with one phrase while voice mode kept running. */
  readonly notice: string | null;
}

/** A failure whose message is written for the person using voice mode. */
export class VoiceModeError extends Schema.TaggedError<VoiceModeError>()("VoiceModeError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const isVoiceModeError = Schema.is(VoiceModeError);

export interface SpeechSourceHandlers {
  /** Sound that may be speech has begun. */
  readonly onSpeechStart: () => void;
  /** The sound has lasted long enough to be speech. */
  readonly onSpeechConfirmed: () => void;
  /** The sound was too short to be speech; no utterance follows. */
  readonly onSpeechCancel: () => void;
  /** One finished utterance: 16 kHz mono samples. */
  readonly onUtterance: (audio: Float32Array) => void;
  /** The microphone failed after it started. */
  readonly onError: (error: unknown) => void;
}

export interface SpeechSource {
  /** Opens the microphone. Rejects with a VoiceModeError. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface VoiceModeTranscriber {
  /** Rejects with a VoiceModeError when transcription cannot work right now. */
  check(signal: AbortSignal): Promise<void>;
  /** Resolves "" for audio with no speech in it. */
  transcribe(audio: Float32Array, signal: AbortSignal): Promise<string>;
}

export interface VoiceModeSpeaker {
  /** Loads the voice so the first reply is not delayed. Rejects with a VoiceModeError. */
  prepare(options: {
    readonly signal: AbortSignal;
    readonly onDownloadProgress: (fraction: number) => void;
    /** The voice broke after it was prepared and can no longer speak. */
    readonly onFailure: (error: unknown) => void;
  }): Promise<void>;
  /** Queues a sentence to be said after the ones already queued. */
  say(text: string): void;
  /** Holds speech in place while the user may be talking. */
  pause(): void;
  resume(): void;
  /** Drops everything queued or being said, and is ready to say something new. */
  stop(): void;
  /** Releases the voice and the audio device. */
  shutDown(): void;
  /** True while anything is queued or audible. */
  isActive(): boolean;
  /** What is being said or was said a moment ago. The microphone may pick it up as an echo. */
  recentText(): string;
  /** Notifies when isActive changes. */
  subscribe(listener: () => void): () => void;
}

export interface ReplyHandlers {
  readonly onSentence: (messageId: string, sentence: string) => void;
  readonly onMessageEnd: (messageId: string) => void;
}

/** The composer on screen and the thread behind it. */
export interface VoiceModeTarget {
  /** Identifies the draft; speech meant for one draft is never written or sent under another. */
  readonly key: string;
  readDraft(): string;
  /** Replaces the whole draft. Returns false when the composer refused the edit. */
  commitDraft(text: string): boolean;
  /** Sends the draft as the Send button would. Returns false when nothing was sent. */
  submit(): boolean;
  isTurnRunning(): boolean;
  interrupt(): void;
  /**
   * Reports the agent's replies in this thread as they stream. A reply already streaming when
   * watching begins is reported only with `includeReplyInProgress`.
   */
  watchReplies(
    handlers: ReplyHandlers,
    options: { readonly includeReplyInProgress: boolean },
  ): () => void;
}

/** A composer's draft, as `sendDraft` reads and rewrites it in the moment before it is sent. */
export interface VoiceModeDraft {
  /** Identifies the thread; a draft keeps it when its first message creates the thread. */
  readonly thread: string;
  read(): string;
  /** Replaces the whole draft. Returns false when the composer refused the edit. */
  replace(text: string): boolean;
}

export interface VoiceModeDependencies {
  readonly createSpeechSource: (handlers: SpeechSourceHandlers) => SpeechSource;
  readonly transcriber: VoiceModeTranscriber;
  readonly speaker: VoiceModeSpeaker;
  /** Runs `run` once after `delayMs`; the returned function cancels it. */
  readonly schedule: (delayMs: number, run: () => void) => () => void;
  /** Read each time it is needed, so a changed setting applies to the next phrase. */
  readonly settings: () => { readonly sendAfterSilenceMs: number };
}

const OFF: VoiceModeState = {
  power: "off",
  activity: "listening",
  downloading: null,
  error: null,
  notice: null,
};

const NO_COMPOSER_NOTICE = "No message box was showing, so that phrase was dropped.";
const DRAFT_REFUSED_NOTICE = "The message box could not take that phrase, so it was dropped.";
const SEND_REFUSED_NOTICE = "The message could not be sent. It is still in the message box.";

const STOP_COMMANDS = new Set(["stop", "stop it", "stop that", "cancel", "cancel that"]);

function spokenWords(text: string): string {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/['’]/gu, "")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).join(" ");
}

/** Echo cancellation is the main filter; this catches the reply's own words leaking through it. */
function isEchoOf(transcript: string, reply: string): boolean {
  const heard = spokenWords(transcript);
  return heard !== "" && ` ${spokenWords(reply)} `.includes(` ${heard} `);
}

function appendPhrase(draft: string, phrase: string): string {
  if (draft.trim() === "") return phrase;
  return /\s$/.test(draft) ? `${draft}${phrase}` : `${draft} ${phrase}`;
}

function describe(error: unknown): string {
  if (isVoiceModeError(error)) return error.message;
  const detail = error instanceof Error ? error.message : String(error);
  return `Voice mode stopped unexpectedly: ${detail}`;
}

interface Utterance {
  readonly audio: Float32Array;
  /** What was being said when the utterance began, kept through transcription delays. */
  readonly replyAtStart: string;
}

export class VoiceModeController {
  private current: VoiceModeState = OFF;
  private readonly listeners = new Set<() => void>();
  // Bumped on every start and stop, so work begun by an earlier run is dropped when it settles.
  private run = 0;
  private abort: AbortController | null = null;
  private source: SpeechSource | null = null;
  private sourceSettled: Promise<unknown> = Promise.resolve();
  private stopListeningToSpeaker: (() => void) | null = null;
  private targets: VoiceModeTarget[] = [];
  /** The key of the composer whose thread the conversation is with. */
  private conversation: string | null = null;
  private stopWatchingReplies: (() => void) | null = null;

  private soundStarted = false;
  private speechConfirmed = false;
  private replyAtSpeechStart = "";
  private utterances: Utterance[] = [];
  private transcribingRun: number | null = null;

  /** The draft as voice mode last left it. Sent after a pause unless someone edits it first. */
  private spokenDraft: { readonly key: string; readonly text: string } | null = null;
  private cancelScheduledSend: (() => void) | null = null;
  /** A message voice mode sent has not been answered yet. */
  private awaitingReply = false;
  /**
   * Threads whose model was last told the conversation is spoken. Kept when voice mode goes off:
   * a model told so is owed the news that it ended.
   */
  private readonly spokenTo = new Set<string>();
  private readonly repliesBeingSaid = new Set<string>();
  /** Replies the user talked over; the rest of each is not said. */
  private readonly repliesCutOff = new Set<string>();

  constructor(private readonly dependencies: VoiceModeDependencies) {}

  get state(): VoiceModeState {
    return this.current;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  toggle(): void {
    if (this.current.power === "off") void this.turnOn();
    else this.turnOff();
  }

  async turnOn(): Promise<void> {
    if (this.current.power !== "off") return;
    const run = ++this.run;
    const abort = new AbortController();
    this.abort = abort;
    this.setState({ ...OFF, power: "starting" });
    try {
      // A microphone still closing from the last run must be released before it is opened again.
      await this.sourceSettled;
      if (run !== this.run) return;
      await this.dependencies.transcriber.check(abort.signal);
      if (run !== this.run) return;
      const source = this.dependencies.createSpeechSource(this.speechHandlers(run));
      this.source = source;
      const started = source.start();
      this.sourceSettled = started.catch(() => undefined);
      await Promise.all([
        started,
        this.dependencies.speaker.prepare({
          signal: abort.signal,
          onDownloadProgress: (fraction) => {
            // A voice already on this device reports complete at once and is not a download.
            if (run === this.run) {
              this.setState({ ...this.current, downloading: fraction < 1 ? fraction : null });
            }
          },
          onFailure: (error) => this.fail(run, error),
        }),
      ]);
    } catch (error) {
      this.fail(run, error);
      return;
    }
    if (run !== this.run) return;
    this.stopListeningToSpeaker = this.dependencies.speaker.subscribe(() => this.refresh());
    this.setState({ ...OFF, power: "on" });
    this.conversation = this.target?.key ?? null;
    this.watchReplies();
  }

  turnOff(): void {
    if (this.current.power === "off") return;
    this.halt();
    this.setState(OFF);
  }

  /** Makes `target` the composer voice mode talks to, until the returned function is called. */
  registerTarget(target: VoiceModeTarget): () => void {
    this.targets.push(target);
    this.followTarget();
    return () => {
      this.targets = this.targets.filter((candidate) => candidate !== target);
      this.followTarget();
    };
  }

  /**
   * Sends a composer's draft through `send`. Every message goes this way, spoken or typed, so
   * that when voice mode has come on or gone off since the thread's model last heard, the message
   * says so after the user's own words.
   */
  sendDraft(draft: VoiceModeDraft, send: () => boolean): boolean {
    const text = draft.read();
    const on = this.current.power === "on";
    // An empty message has nothing to carry the note, and a command must stay a command.
    const carriesNote =
      text.trim() !== "" &&
      !text.trimStart().startsWith("/") &&
      on !== this.spokenTo.has(draft.thread);
    const noted = on ? withVoiceModeInstructions(text) : withVoiceModeEnded(text);
    // A draft that cannot take the note is sent as it is; the note goes with the next message.
    if (!carriesNote || !draft.replace(noted)) return send();
    if (!send()) {
      draft.replace(text);
      return false;
    }
    if (on) this.spokenTo.add(draft.thread);
    else this.spokenTo.delete(draft.thread);
    return true;
  }

  private get target(): VoiceModeTarget | null {
    return this.targets.at(-1) ?? null;
  }

  private followTarget(): void {
    const target = this.target;
    // A composer that went away or was only re-registered leaves the conversation where it is,
    // so a reply keeps being read while the user looks at settings or the composer re-renders.
    if (!target || target.key === this.conversation) return;
    this.conversation = target.key;
    this.cancelSend();
    this.spokenDraft = null;
    if (this.current.power !== "on") return;
    // The reply being read belongs to the thread that was just left.
    this.cutOffSpeech();
    this.watchReplies();
    this.refresh();
  }

  private watchReplies(): void {
    this.stopWatchingReplies?.();
    this.stopWatchingReplies =
      this.target?.watchReplies(
        {
          onSentence: (messageId, sentence) => {
            if (this.current.power !== "on" || this.repliesCutOff.has(messageId)) return;
            this.awaitingReply = false;
            this.repliesBeingSaid.add(messageId);
            this.dependencies.speaker.say(sentence);
          },
          onMessageEnd: (messageId) => {
            this.repliesBeingSaid.delete(messageId);
            this.repliesCutOff.delete(messageId);
          },
        },
        { includeReplyInProgress: this.awaitingReply },
      ) ?? null;
  }

  private speechHandlers(run: number): SpeechSourceHandlers {
    return {
      onSpeechStart: () => {
        if (run !== this.run) return;
        this.soundStarted = true;
        this.replyAtSpeechStart = this.dependencies.speaker.recentText();
        this.cancelSend();
        this.refresh();
      },
      onSpeechConfirmed: () => {
        if (run !== this.run) return;
        this.speechConfirmed = true;
        this.dependencies.speaker.pause();
        this.refresh();
      },
      onSpeechCancel: () => {
        if (run !== this.run) return;
        this.soundStarted = false;
        this.speechConfirmed = false;
        this.dependencies.speaker.resume();
        this.scheduleSend();
        this.refresh();
      },
      onUtterance: (audio) => {
        if (run !== this.run || this.current.power !== "on") return;
        this.soundStarted = false;
        this.speechConfirmed = false;
        this.utterances.push({ audio, replyAtStart: this.replyAtSpeechStart });
        void this.transcribeUtterances(run);
      },
      onError: (error) => this.fail(run, error),
    };
  }

  // One utterance at a time, so each lands in the draft before the next is appended to it.
  private async transcribeUtterances(run: number): Promise<void> {
    if (this.transcribingRun === run) return;
    this.transcribingRun = run;
    try {
      for (let next = this.utterances.shift(); next; next = this.utterances.shift()) {
        this.refresh();
        await this.hear(run, next);
        if (run !== this.run) return;
      }
    } catch (error) {
      this.fail(run, error);
    } finally {
      if (this.transcribingRun === run) this.transcribingRun = null;
    }
    if (run !== this.run) return;
    this.scheduleSend();
    this.refresh();
  }

  private async hear(run: number, utterance: Utterance): Promise<void> {
    const abort = this.abort;
    if (!abort) return;
    const { speaker, transcriber } = this.dependencies;
    const phrase = (await transcriber.transcribe(utterance.audio, abort.signal)).trim();
    if (run !== this.run) return;
    if (phrase === "" || isEchoOf(phrase, `${utterance.replyAtStart} ${speaker.recentText()}`)) {
      // Not the user talking after all. Carry on, unless they have started again since.
      if (!this.speechConfirmed) speaker.resume();
      return;
    }
    this.cutOffSpeech();
    const target = this.target;
    if (!target) {
      this.setState({ ...this.current, notice: NO_COMPOSER_NOTICE });
      return;
    }
    if (STOP_COMMANDS.has(spokenWords(phrase))) {
      // The draft stays as it is, for the user to send or change by hand.
      this.spokenDraft = null;
      if (target.isTurnRunning()) target.interrupt();
      return;
    }
    const draft = appendPhrase(target.readDraft(), phrase);
    if (!target.commitDraft(draft)) {
      this.setState({ ...this.current, notice: DRAFT_REFUSED_NOTICE });
      return;
    }
    this.spokenDraft = { key: target.key, text: draft };
    this.setState({ ...this.current, notice: null });
  }

  private cutOffSpeech(): void {
    for (const messageId of this.repliesBeingSaid) this.repliesCutOff.add(messageId);
    this.repliesBeingSaid.clear();
    this.dependencies.speaker.stop();
  }

  private scheduleSend(): void {
    const run = this.run;
    const spoken = this.spokenDraft;
    if (
      this.current.power !== "on" ||
      !spoken ||
      this.cancelScheduledSend ||
      this.soundStarted ||
      this.utterances.length > 0 ||
      this.transcribingRun !== null
    ) {
      return;
    }
    this.cancelScheduledSend = this.dependencies.schedule(
      this.dependencies.settings().sendAfterSilenceMs,
      () => {
        this.cancelScheduledSend = null;
        if (run !== this.run) return;
        this.send(spoken);
        this.refresh();
      },
    );
  }

  private send(spoken: { readonly key: string; readonly text: string }): void {
    this.spokenDraft = null;
    const target = this.target;
    // A draft changed by hand since the last phrase is the user's to send.
    if (!target || target.key !== spoken.key || target.readDraft() !== spoken.text) return;
    if (target.submit()) {
      this.awaitingReply = true;
      return;
    }
    this.setState({ ...this.current, notice: SEND_REFUSED_NOTICE });
  }

  private cancelSend(): void {
    this.cancelScheduledSend?.();
    this.cancelScheduledSend = null;
  }

  private fail(run: number, error: unknown): void {
    if (run !== this.run) return;
    this.halt();
    this.setState({ ...OFF, error: describe(error) });
  }

  private halt(): void {
    this.run += 1;
    this.abort?.abort();
    this.abort = null;
    this.cancelSend();
    this.stopWatchingReplies?.();
    this.stopWatchingReplies = null;
    this.conversation = null;
    this.stopListeningToSpeaker?.();
    this.stopListeningToSpeaker = null;
    this.soundStarted = false;
    this.speechConfirmed = false;
    this.utterances = [];
    this.spokenDraft = null;
    this.awaitingReply = false;
    this.repliesBeingSaid.clear();
    this.repliesCutOff.clear();
    this.dependencies.speaker.shutDown();
    const source = this.source;
    this.source = null;
    if (source) {
      // A start cancelled part-way can still open the microphone, so stop once it has settled.
      this.sourceSettled = this.sourceSettled.then(() => source.stop()).catch(() => undefined);
    }
  }

  private refresh(): void {
    if (this.current.power !== "on") return;
    const activity: VoiceModeActivity = this.speechConfirmed
      ? "hearing"
      : this.transcribingRun !== null || this.utterances.length > 0
        ? "transcribing"
        : this.cancelScheduledSend
          ? "sending"
          : this.dependencies.speaker.isActive()
            ? "speaking"
            : "listening";
    this.setState({ ...this.current, activity });
  }

  private setState(next: VoiceModeState): void {
    const previous = this.current;
    if (
      previous.power === next.power &&
      previous.activity === next.activity &&
      previous.downloading === next.downloading &&
      previous.error === next.error &&
      previous.notice === next.notice
    ) {
      return;
    }
    this.current = next;
    for (const listener of this.listeners) listener();
  }
}
