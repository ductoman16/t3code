import { describe, expect, it } from "vite-plus/test";

import {
  VoiceModeController,
  VoiceModeError,
  type ReplyHandlers,
  type SpeechSourceHandlers,
  type VoiceModeSpeaker,
  type VoiceModeTarget,
} from "./voiceModeController";
import { withVoiceModeEnded, withVoiceModeInstructions } from "./voiceModeInstructions";

const SEND_AFTER_SILENCE_MS = 800;
const AUDIO = new Float32Array(1600);

/**
 * Lets the controller finish reacting to a promise that just settled. Its continuations run in
 * microtasks, a few deep; no clock is involved.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

class StubMicrophone {
  handlers: SpeechSourceHandlers | null = null;
  open = false;
  startFailure: Error | null = null;

  readonly create = (handlers: SpeechSourceHandlers) => {
    this.handlers = handlers;
    return {
      start: async () => {
        if (this.startFailure) throw this.startFailure;
        this.open = true;
      },
      stop: async () => {
        this.open = false;
      },
    };
  };
}

class StubTranscriber {
  checkFailure: Error | null = null;
  private readonly pending: Array<(transcript: string) => void> = [];

  check = async () => {
    if (this.checkFailure) throw this.checkFailure;
  };

  transcribe = () => new Promise<string>((resolve) => this.pending.push(resolve));

  /** Finishes the oldest transcription in progress. */
  async answer(transcript: string): Promise<void> {
    const resolve = this.pending.shift();
    if (!resolve) throw new Error("No transcription is in progress.");
    resolve(transcript);
    await settle();
  }
}

class StubSpeaker implements VoiceModeSpeaker {
  said: string[] = [];
  paused = false;
  running = false;
  prepareFailure: Error | null = null;
  downloadProgress: number[] = [];
  private queue: string[] = [];
  private readonly listeners = new Set<() => void>();
  private reportFailure: ((error: unknown) => void) | null = null;

  prepare: VoiceModeSpeaker["prepare"] = async ({ onDownloadProgress, onFailure }) => {
    for (const fraction of this.downloadProgress) onDownloadProgress(fraction);
    if (this.prepareFailure) throw this.prepareFailure;
    this.reportFailure = onFailure;
    this.running = true;
  };
  say = (text: string) => {
    this.said.push(text);
    this.queue.push(text);
    this.notify();
  };
  pause = () => {
    this.paused = true;
  };
  resume = () => {
    this.paused = false;
  };
  stop = () => {
    this.queue = [];
    this.paused = false;
    this.notify();
  };
  shutDown = () => {
    this.queue = [];
    this.running = false;
  };
  isActive = () => this.queue.length > 0;
  recentText = () => this.queue.join(" ");
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The voice breaks while voice mode is on. */
  breakDown(error: Error): void {
    this.reportFailure?.(error);
  }

  /** The queued sentences finish playing. */
  finishSpeaking(): void {
    this.queue = [];
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

class StubComposer implements VoiceModeTarget {
  draft = "";
  sent: string[] = [];
  turnRunning = false;
  interrupts = 0;
  refusesEdits = false;
  refusesSends = false;
  /** A reply that was already streaming when voice mode started watching this thread. */
  replyInProgress: { readonly messageId: string; readonly sentence: string } | null = null;
  private replies: ReplyHandlers | null = null;

  /** The controller every send goes through, as it does in the app. */
  constructor(
    readonly key: string,
    private readonly voiceMode: VoiceModeController,
    readonly thread = key,
  ) {}

  readDraft = () => this.draft;
  commitDraft = (text: string) => {
    if (this.refusesEdits) return false;
    this.draft = text;
    return true;
  };
  submit = () =>
    this.voiceMode.sendDraft(
      { thread: this.thread, read: this.readDraft, replace: this.commitDraft },
      () => {
        if (this.refusesSends) return false;
        this.sent.push(this.draft);
        this.draft = "";
        return true;
      },
    );
  /** The user types a message and presses Send. */
  type(text: string): void {
    this.draft = text;
    this.submit();
  }
  isTurnRunning = () => this.turnRunning;
  interrupt = () => {
    this.interrupts += 1;
  };
  watchReplies: VoiceModeTarget["watchReplies"] = (handlers, { includeReplyInProgress }) => {
    this.replies = handlers;
    if (includeReplyInProgress && this.replyInProgress) {
      handlers.onSentence(this.replyInProgress.messageId, this.replyInProgress.sentence);
    }
    return () => {
      if (this.replies === handlers) this.replies = null;
    };
  };

  reply(messageId: string, sentence: string): void {
    this.replies?.onSentence(messageId, sentence);
  }
  endReply(messageId: string): void {
    this.replies?.onMessageEnd(messageId);
  }
}

class StubClock {
  private timers: Array<{ at: number; run: () => void }> = [];
  private now = 0;

  readonly schedule = (delayMs: number, run: () => void) => {
    const timer = { at: this.now + delayMs, run };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((candidate) => candidate !== timer);
    };
  };

  advance(ms: number): void {
    this.now += ms;
    const due = this.timers.filter((timer) => timer.at <= this.now);
    this.timers = this.timers.filter((timer) => timer.at > this.now);
    for (const timer of due) timer.run();
  }
}

function setUp() {
  const microphone = new StubMicrophone();
  const transcriber = new StubTranscriber();
  const speaker = new StubSpeaker();
  const clock = new StubClock();
  const controller = new VoiceModeController({
    createSpeechSource: microphone.create,
    transcriber,
    speaker,
    schedule: clock.schedule,
    settings: () => ({ sendAfterSilenceMs: SEND_AFTER_SILENCE_MS }),
  });
  const composer = new StubComposer("thread-1", controller);
  const leaveComposer = controller.registerTarget(composer);

  /** The user says one phrase and transcription returns `transcript` for it. */
  const say = async (transcript: string) => {
    microphone.handlers?.onSpeechStart();
    microphone.handlers?.onSpeechConfirmed();
    microphone.handlers?.onUtterance(AUDIO);
    await transcriber.answer(transcript);
  };

  return { microphone, transcriber, speaker, clock, composer, leaveComposer, controller, say };
}

async function setUpOn() {
  const context = setUp();
  await context.controller.turnOn();
  return context;
}

describe("VoiceModeController", () => {
  describe("turning on and off", () => {
    it("opens the microphone and listens", async () => {
      const { controller, microphone, speaker } = await setUpOn();

      expect(controller.state).toMatchObject({ power: "on", activity: "listening", error: null });
      expect(microphone.open).toBe(true);
      expect(speaker.running).toBe(true);
    });

    it("closes the microphone and releases the voice when turned off", async () => {
      const { controller, microphone, speaker } = await setUpOn();

      controller.turnOff();
      await settle();

      expect(controller.state.power).toBe("off");
      expect(microphone.open).toBe(false);
      expect(speaker.running).toBe(false);
    });

    it("reports the speech model download while starting", async () => {
      const { controller, speaker } = setUp();
      speaker.downloadProgress = [0.25, 0.5];
      const seen: Array<number | null> = [];
      controller.subscribe(() => seen.push(controller.state.downloading));

      await controller.turnOn();

      expect(seen).toContain(0.25);
      expect(seen).toContain(0.5);
      expect(controller.state.downloading).toBeNull();
    });

    it("does not report a download for a voice that is already on this device", async () => {
      const { controller, speaker } = setUp();
      speaker.downloadProgress = [1];
      const seen: Array<number | null> = [];
      controller.subscribe(() => seen.push(controller.state.downloading));

      await controller.turnOn();

      expect(seen.every((downloading) => downloading === null)).toBe(true);
    });

    it("stays off and says why when transcription is not set up, without opening the microphone", async () => {
      const { controller, microphone, transcriber } = setUp();
      transcriber.checkFailure = new VoiceModeError({
        message: "Choose where to transcribe in Settings.",
      });

      await controller.turnOn();

      expect(controller.state).toMatchObject({
        power: "off",
        error: "Choose where to transcribe in Settings.",
      });
      expect(microphone.handlers).toBeNull();
    });

    it("stays off and releases the voice when the microphone cannot be opened", async () => {
      const { controller, microphone, speaker } = setUp();
      microphone.startFailure = new VoiceModeError({ message: "Microphone access was denied." });

      await controller.turnOn();

      expect(controller.state).toMatchObject({
        power: "off",
        error: "Microphone access was denied.",
      });
      expect(speaker.running).toBe(false);
    });

    it("stays off and closes the microphone when the voice cannot be loaded", async () => {
      const { controller, microphone, speaker } = setUp();
      speaker.prepareFailure = new VoiceModeError({ message: "This device cannot speak replies." });

      await controller.turnOn();
      await settle();

      expect(controller.state).toMatchObject({
        power: "off",
        error: "This device cannot speak replies.",
      });
      expect(microphone.open).toBe(false);
    });

    it("turns itself off, with the cause, when the microphone fails later", async () => {
      const { controller, microphone } = await setUpOn();

      microphone.handlers?.onError(new Error("device unplugged"));

      expect(controller.state).toMatchObject({
        power: "off",
        error: "Voice mode stopped unexpectedly: device unplugged",
      });
    });

    it("turns itself off, with the cause, when the voice fails later", async () => {
      const { controller, microphone, speaker } = await setUpOn();

      speaker.breakDown(
        new VoiceModeError({ message: "The voice stopped working: GPU device lost." }),
      );
      await settle();

      expect(controller.state).toMatchObject({
        power: "off",
        error: "The voice stopped working: GPU device lost.",
      });
      expect(microphone.open).toBe(false);
    });

    it("drops a phrase still being transcribed when turned off", async () => {
      const { controller, composer, microphone, transcriber, clock } = await setUpOn();
      microphone.handlers?.onSpeechStart();
      microphone.handlers?.onUtterance(AUDIO);

      controller.turnOff();
      await transcriber.answer("run the tests");
      clock.advance(SEND_AFTER_SILENCE_MS);

      expect(composer.draft).toBe("");
      expect(composer.sent).toEqual([]);
    });
  });

  describe("talking to the agent", () => {
    it("puts a phrase in the draft and sends it after a pause", async () => {
      const { controller, composer, clock, say } = await setUpOn();

      await say("run the tests");

      expect(composer.draft).toBe("run the tests");
      expect(composer.sent).toEqual([]);
      expect(controller.state.activity).toBe("sending");

      clock.advance(SEND_AFTER_SILENCE_MS);

      expect(composer.sent).toEqual([withVoiceModeInstructions("run the tests")]);
      expect(controller.state.activity).toBe("listening");
    });

    it("keeps collecting phrases until the pause, then sends them as one message", async () => {
      const { composer, clock, say } = await setUpOn();

      await say("run the tests");
      clock.advance(SEND_AFTER_SILENCE_MS - 1);
      await say("and fix what fails");
      clock.advance(SEND_AFTER_SILENCE_MS - 1);

      expect(composer.sent).toEqual([]);

      clock.advance(1);

      expect(composer.sent).toEqual([
        withVoiceModeInstructions("run the tests and fix what fails"),
      ]);
    });

    it("adds a phrase to text already typed in the draft", async () => {
      const { composer, clock, say } = await setUpOn();
      composer.draft = "In the parser,";

      await say("rename the helper");
      clock.advance(SEND_AFTER_SILENCE_MS);

      expect(composer.sent).toEqual([
        withVoiceModeInstructions("In the parser, rename the helper"),
      ]);
    });

    it("does not send while the user is still talking", async () => {
      const { composer, microphone, clock, say } = await setUpOn();
      await say("run the tests");

      microphone.handlers?.onSpeechStart();
      clock.advance(SEND_AFTER_SILENCE_MS * 2);

      expect(composer.sent).toEqual([]);
    });

    it("sends after a noise that turned out not to be speech", async () => {
      const { composer, microphone, clock, say } = await setUpOn();
      await say("run the tests");

      microphone.handlers?.onSpeechStart();
      microphone.handlers?.onSpeechCancel();
      clock.advance(SEND_AFTER_SILENCE_MS);

      expect(composer.sent).toEqual([withVoiceModeInstructions("run the tests")]);
    });

    it("leaves a draft edited by hand for the user to send", async () => {
      const { composer, clock, say } = await setUpOn();
      await say("run the tests");

      composer.draft = "run the unit tests";
      clock.advance(SEND_AFTER_SILENCE_MS);

      expect(composer.sent).toEqual([]);
      expect(composer.draft).toBe("run the unit tests");
    });

    it("shows that it is hearing, then transcribing", async () => {
      const { controller, microphone, transcriber } = await setUpOn();

      microphone.handlers?.onSpeechStart();
      microphone.handlers?.onSpeechConfirmed();
      expect(controller.state.activity).toBe("hearing");

      microphone.handlers?.onUtterance(AUDIO);
      expect(controller.state.activity).toBe("transcribing");

      await transcriber.answer("");
      expect(controller.state.activity).toBe("listening");
    });

    it("ignores audio with no words in it", async () => {
      const { composer, clock, say } = await setUpOn();

      await say("");
      clock.advance(SEND_AFTER_SILENCE_MS);

      expect(composer.draft).toBe("");
      expect(composer.sent).toEqual([]);
    });

    it("drops a phrase and says so when the composer refuses the edit", async () => {
      const { controller, composer, clock, say } = await setUpOn();
      composer.refusesEdits = true;

      await say("run the tests");
      clock.advance(SEND_AFTER_SILENCE_MS);

      expect(controller.state.notice).toBe(
        "The message box could not take that phrase, so it was dropped.",
      );
      expect(composer.sent).toEqual([]);
    });

    it("drops a phrase and says so when no composer is showing", async () => {
      const microphone = new StubMicrophone();
      const transcriber = new StubTranscriber();
      const controller = new VoiceModeController({
        createSpeechSource: microphone.create,
        transcriber,
        speaker: new StubSpeaker(),
        schedule: new StubClock().schedule,
        settings: () => ({ sendAfterSilenceMs: SEND_AFTER_SILENCE_MS }),
      });
      await controller.turnOn();

      microphone.handlers?.onSpeechStart();
      microphone.handlers?.onUtterance(AUDIO);
      await transcriber.answer("run the tests");

      expect(controller.state.notice).toBe(
        "No message box was showing, so that phrase was dropped.",
      );
    });

    it("does not send a phrase to a different thread than the one it was said in", async () => {
      const { controller, composer, clock, say } = await setUpOn();
      await say("run the tests");

      const other = new StubComposer("thread-2", controller);
      controller.registerTarget(other);
      clock.advance(SEND_AFTER_SILENCE_MS);

      expect(composer.sent).toEqual([]);
      expect(other.sent).toEqual([]);
    });
  });

  describe("staying with its thread", () => {
    it("turns itself off when the user opens another thread", async () => {
      const { controller, microphone, speaker, composer } = await setUpOn();
      composer.reply("message-1", "I found the bug.");

      controller.registerTarget(new StubComposer("thread-2", controller));
      await settle();

      expect(controller.state).toMatchObject({ power: "off", error: null });
      expect(microphone.open).toBe(false);
      expect(speaker.running).toBe(false);
    });

    it("turns itself off when the user opens another thread while it is starting", async () => {
      const { controller, microphone } = setUp();
      const starting = controller.turnOn();

      controller.registerTarget(new StubComposer("thread-2", controller));
      await starting;
      await settle();

      expect(controller.state.power).toBe("off");
      expect(microphone.open).toBe(false);
    });

    it("stays on when a new draft's first message turns it into its thread", async () => {
      const { controller, leaveComposer, clock, speaker, say } = setUp();
      // A new thread's draft is the only composer on screen.
      leaveComposer();
      const draft = new StubComposer("draft-1", controller, "thread-9");
      const leaveDraft = controller.registerTarget(draft);
      await controller.turnOn();
      await say("start a changelog");
      clock.advance(SEND_AFTER_SILENCE_MS);

      leaveDraft();
      const created = new StubComposer("thread-9", controller);
      created.replyInProgress = { messageId: "message-1", sentence: "Started it." };
      controller.registerTarget(created);

      expect(controller.state.power).toBe("on");
      expect(speaker.said).toEqual(["Started it."]);
    });

    it("can be turned on again in the thread the user moved to", async () => {
      const { controller, clock } = await setUpOn();
      const other = new StubComposer("thread-2", controller);
      controller.registerTarget(other);

      await controller.turnOn();
      other.type("list the branches");

      expect(controller.state.power).toBe("on");
      expect(other.sent).toEqual([withVoiceModeInstructions("list the branches")]);
      clock.advance(SEND_AFTER_SILENCE_MS);
    });
  });

  describe("telling the agent about voice mode", () => {
    it("says so with the first spoken message and not with the next", async () => {
      const { composer, clock, say } = await setUpOn();

      await say("how many are left");
      clock.advance(SEND_AFTER_SILENCE_MS);
      await say("zero");
      clock.advance(SEND_AFTER_SILENCE_MS);

      expect(composer.sent).toEqual([withVoiceModeInstructions("how many are left"), "zero"]);
    });

    it("says so with a typed message too, since its reply is read aloud", async () => {
      const { composer } = await setUpOn();

      composer.type("run the tests");

      expect(composer.sent).toEqual([withVoiceModeInstructions("run the tests")]);
    });

    it("tells a thread it left voice mode when the user moved to another thread", async () => {
      const { controller, composer, clock, say } = await setUpOn();
      await say("run the tests");
      clock.advance(SEND_AFTER_SILENCE_MS);

      const leaveOther = controller.registerTarget(new StubComposer("thread-2", controller));
      leaveOther();
      composer.type("now fix the parser");

      expect(composer.sent).toEqual([
        withVoiceModeInstructions("run the tests"),
        withVoiceModeEnded("now fix the parser"),
      ]);
    });

    it("does not repeat it when the first message turns a draft into a thread", async () => {
      const { controller, leaveComposer, clock, say } = setUp();
      leaveComposer();
      const draft = new StubComposer("draft-1", controller, "thread-9");
      const leaveDraft = controller.registerTarget(draft);
      await controller.turnOn();
      await say("start a changelog");
      clock.advance(SEND_AFTER_SILENCE_MS);

      leaveDraft();
      const thread = new StubComposer("thread-9", controller);
      controller.registerTarget(thread);
      await say("add today's entry");
      clock.advance(SEND_AFTER_SILENCE_MS);

      expect(draft.sent).toEqual([withVoiceModeInstructions("start a changelog")]);
      expect(thread.sent).toEqual(["add today's entry"]);
    });

    it("says voice mode has ended with the next message typed after it is turned off", async () => {
      const { controller, composer, clock, say } = await setUpOn();
      await say("run the tests");
      clock.advance(SEND_AFTER_SILENCE_MS);

      controller.turnOff();
      composer.type("now fix the parser");
      composer.type("and the lexer");

      expect(composer.sent.slice(1)).toEqual([
        withVoiceModeEnded("now fix the parser"),
        "and the lexer",
      ]);
    });

    it("says so when voice mode turned itself off as well", async () => {
      const { composer, clock, speaker, say } = await setUpOn();
      await say("run the tests");
      clock.advance(SEND_AFTER_SILENCE_MS);

      speaker.breakDown(new VoiceModeError({ message: "The voice stopped working." }));
      composer.type("now fix the parser");

      expect(composer.sent.at(-1)).toBe(withVoiceModeEnded("now fix the parser"));
    });

    it("says nothing about ending to a thread that was never told it began", async () => {
      const { controller, composer } = await setUpOn();

      controller.turnOff();
      composer.type("run the tests");

      expect(composer.sent).toEqual(["run the tests"]);
    });

    it("says nothing when voice mode is back on before anything was typed", async () => {
      const { controller, composer, clock, say } = await setUpOn();
      await say("run the tests");
      clock.advance(SEND_AFTER_SILENCE_MS);

      controller.turnOff();
      await controller.turnOn();
      await say("run them again");
      clock.advance(SEND_AFTER_SILENCE_MS);

      expect(composer.sent).toEqual([withVoiceModeInstructions("run the tests"), "run them again"]);
    });

    it("tells the agent again when voice mode comes back after it was told it ended", async () => {
      const { controller, composer, clock, say } = await setUpOn();
      await say("run the tests");
      clock.advance(SEND_AFTER_SILENCE_MS);
      controller.turnOff();
      composer.type("now fix the parser");

      await controller.turnOn();
      await say("run them again");
      clock.advance(SEND_AFTER_SILENCE_MS);

      expect(composer.sent.at(-1)).toBe(withVoiceModeInstructions("run them again"));
    });

    it("leaves a command as it is and tells the agent with the message after it", async () => {
      const { controller, composer, clock, say } = await setUpOn();
      await say("run the tests");
      clock.advance(SEND_AFTER_SILENCE_MS);
      controller.turnOff();

      composer.type("/compact");
      composer.type("now fix the parser");

      expect(composer.sent.slice(1)).toEqual([
        "/compact",
        withVoiceModeEnded("now fix the parser"),
      ]);
    });

    it("keeps only the user's words in the message box when the send is refused", async () => {
      const { controller, composer, clock, say } = await setUpOn();
      composer.refusesSends = true;

      await say("run the tests");
      clock.advance(SEND_AFTER_SILENCE_MS);

      expect(composer.draft).toBe("run the tests");
      expect(controller.state.notice).toBe(
        "The message could not be sent. It is still in the message box.",
      );

      composer.refusesSends = false;
      await say("please");
      clock.advance(SEND_AFTER_SILENCE_MS);

      expect(composer.sent).toEqual([withVoiceModeInstructions("run the tests please")]);
    });

    it("sends a message as it is when the message box cannot take the note", async () => {
      const { composer } = await setUpOn();
      composer.draft = "run the tests";
      composer.refusesEdits = true;

      composer.submit();

      expect(composer.sent).toEqual(["run the tests"]);
    });
  });

  describe("hearing the agent", () => {
    it("reads the reply aloud, sentence by sentence", async () => {
      const { controller, composer, speaker } = await setUpOn();

      composer.reply("message-1", "I found the bug.");
      composer.reply("message-1", "It is in the parser.");

      expect(speaker.said).toEqual(["I found the bug.", "It is in the parser."]);
      expect(controller.state.activity).toBe("speaking");

      speaker.finishSpeaking();

      expect(controller.state.activity).toBe("listening");
    });

    it("says nothing once turned off", async () => {
      const { controller, composer, speaker } = await setUpOn();

      controller.turnOff();
      composer.reply("message-1", "I found the bug.");

      expect(speaker.said).toEqual([]);
    });

    it("holds the reply while the user may be talking and carries on if it was only noise", async () => {
      const { composer, microphone, speaker, transcriber } = await setUpOn();
      composer.reply("message-1", "I found the bug.");

      microphone.handlers?.onSpeechStart();
      microphone.handlers?.onSpeechConfirmed();
      expect(speaker.paused).toBe(true);

      microphone.handlers?.onUtterance(AUDIO);
      await transcriber.answer("");

      expect(speaker.paused).toBe(false);
      expect(speaker.isActive()).toBe(true);
    });

    it("carries on when the microphone only picked up the reply itself", async () => {
      const { composer, speaker, say } = await setUpOn();
      composer.reply("message-1", "I found the bug. It is in the parser.");

      await say("It is in the parser");

      expect(speaker.isActive()).toBe(true);
      expect(speaker.paused).toBe(false);
      expect(composer.draft).toBe("");
    });

    it("stops the reply when the user talks over it, and does not say the rest of it", async () => {
      const { composer, speaker, say } = await setUpOn();
      composer.reply("message-1", "I found the bug.");

      await say("actually, check the config first");
      composer.reply("message-1", "It is in the parser.");

      expect(speaker.isActive()).toBe(false);
      expect(speaker.said).toEqual(["I found the bug."]);
      expect(composer.draft).toBe("actually, check the config first");
    });

    it("reads the next reply after one was cut off", async () => {
      const { composer, speaker, say } = await setUpOn();
      composer.reply("message-1", "I found the bug.");
      await say("actually, check the config first");
      composer.endReply("message-1");

      composer.reply("message-2", "The config looks fine.");

      expect(speaker.said).toEqual(["I found the bug.", "The config looks fine."]);
    });

    it("keeps reading while the composer is away or re-rendered for the same thread", async () => {
      const { controller, composer, speaker } = await setUpOn();
      const leave = controller.registerTarget(new StubComposer("thread-1", controller));
      composer.reply("message-1", "I found the bug.");

      leave();
      controller.registerTarget(new StubComposer("thread-1", controller));

      expect(speaker.isActive()).toBe(true);
    });

    it("still sends after a pause when the composer was re-rendered meanwhile", async () => {
      const { controller, composer, clock, say } = await setUpOn();
      await say("run the tests");

      const rerendered = new StubComposer("thread-1", controller);
      rerendered.draft = composer.draft;
      controller.registerTarget(rerendered);
      clock.advance(SEND_AFTER_SILENCE_MS);

      expect(rerendered.sent).toEqual([withVoiceModeInstructions("run the tests")]);
    });

    it("does not read a reply already streaming when voice mode comes on", async () => {
      const { controller, composer, speaker } = setUp();
      composer.replyInProgress = { messageId: "message-9", sentence: "Unrelated work." };

      await controller.turnOn();

      expect(speaker.said).toEqual([]);
    });
  });

  describe("stopping the agent by voice", () => {
    it("interrupts the running turn and leaves the draft alone", async () => {
      const { composer, clock, say } = await setUpOn();
      composer.turnRunning = true;
      composer.draft = "half a thought";

      await say("Stop.");
      clock.advance(SEND_AFTER_SILENCE_MS);

      expect(composer.interrupts).toBe(1);
      expect(composer.draft).toBe("half a thought");
      expect(composer.sent).toEqual([]);
    });

    it("silences the reply without interrupting when no turn is running", async () => {
      const { composer, speaker, say } = await setUpOn();
      composer.reply("message-1", "I found the bug.");

      await say("stop");

      expect(speaker.isActive()).toBe(false);
      expect(composer.interrupts).toBe(0);
    });

    it("treats a longer sentence containing the word as a message", async () => {
      const { composer, clock, say } = await setUpOn();
      composer.turnRunning = true;

      await say("stop using the old parser");
      clock.advance(SEND_AFTER_SILENCE_MS);

      expect(composer.interrupts).toBe(0);
      expect(composer.sent).toEqual([withVoiceModeInstructions("stop using the old parser")]);
    });
  });
});
