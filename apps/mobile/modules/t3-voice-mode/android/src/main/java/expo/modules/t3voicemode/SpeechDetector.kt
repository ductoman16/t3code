package expo.modules.t3voicemode

import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Finds utterances in a stream of 16 kHz mono PCM16 frames, deciding frame by frame from the
 * model's speech probability the way the web client's detector (vad-web's frame processor) does.
 */
internal class SpeechDetector(private val model: SpeechModel) {
  sealed interface Event {
    data object Start : Event
    data object Confirmed : Event
    data object Cancel : Event
    class Utterance(val pcm: ShortArray) : Event
  }

  private val frames = ArrayList<ShortArray>()
  private var speaking = false
  private var confirmed = false
  private var speechFrames = 0
  private var requiredSpeechFrames = 0
  private var redemptionCounter = 0
  private var strictMs = 0

  /** Whether the agent's voice is playing. */
  var talkingOver = false

  fun process(frame: ShortArray): Event? {
    strictMs = if (talkingOver) TALK_OVER_TAIL_MS else max(strictMs - FRAME_MS, 0)
    val strict = strictMs > 0
    // The model sees every frame, even ones the level rules out, to keep its state continuous.
    val modelProbability = model.speechProbability(frame)
    val minLevelDb = if (strict) TALK_OVER_MIN_LEVEL_DB else FLOOR_LIMIT_DB
    val probability = if (levelDb(frame) < minLevelDb) 0f else modelProbability
    val isSpeech =
      probability >= if (strict) TALK_OVER_SPEECH_THRESHOLD else POSITIVE_SPEECH_THRESHOLD
    frames.add(frame)
    return if (speaking) hear(probability, isSpeech) else listen(isSpeech, strict)
  }

  /** Ends whatever is being heard, as when the microphone closes. */
  fun flush(): Event? = if (speaking) finish() else null

  private fun listen(isSpeech: Boolean, strict: Boolean): Event? {
    if (!isSpeech) {
      while (frames.size > PRE_SPEECH_PAD_MS / FRAME_MS) frames.removeAt(0)
      return null
    }
    speaking = true
    confirmed = false
    speechFrames = 1
    redemptionCounter = 0
    requiredSpeechFrames = (if (strict) TALK_OVER_MIN_SPEECH_MS else MIN_SPEECH_MS) / FRAME_MS
    return Event.Start
  }

  private fun hear(probability: Float, isSpeech: Boolean): Event? {
    if (isSpeech) {
      speechFrames++
      redemptionCounter = 0
    } else if (probability < NEGATIVE_SPEECH_THRESHOLD) {
      redemptionCounter++
    }
    return when {
      !confirmed && speechFrames >= requiredSpeechFrames -> {
        confirmed = true
        Event.Confirmed
      }
      redemptionCounter >= REDEMPTION_MS / FRAME_MS -> finish()
      frames.size * FRAME_MS >= MAX_UTTERANCE_MS -> finish()
      else -> null
    }
  }

  private fun finish(): Event {
    val event = if (confirmed) Event.Utterance(join(frames)) else Event.Cancel
    speaking = false
    frames.clear()
    return event
  }

  companion object {
    /** Silero's 512-sample frames at 16 kHz. */
    private const val FRAME_MS = 32

    // The web client's settings: a frame this likely to be speech starts or continues an utterance,
    // and one less likely than the negative threshold counts toward the pause that ends it.
    private const val POSITIVE_SPEECH_THRESHOLD = 0.5f
    private const val NEGATIVE_SPEECH_THRESHOLD = 0.35f
    private const val MIN_SPEECH_MS = 160
    private const val REDEMPTION_MS = 600
    private const val PRE_SPEECH_PAD_MS = 300
    private const val MAX_UTTERANCE_MS = 30_000

    /** Quieter than this is never speech. */
    private const val FLOOR_LIMIT_DB = -58.0

    // While the agent's voice plays, speech must be this likely, this loud and this long, so the
    // echo the phone's canceller leaves behind is not taken for the user.
    private const val TALK_OVER_SPEECH_THRESHOLD = 0.8f
    private const val TALK_OVER_MIN_LEVEL_DB = -40.0
    private const val TALK_OVER_MIN_SPEECH_MS = 400

    /** How long that stricter hearing lasts after the voice stops, while its echo dies away. */
    private const val TALK_OVER_TAIL_MS = 500

    fun levelDb(frame: ShortArray): Double {
      if (frame.isEmpty()) return -100.0
      var sum = 0.0
      for (sample in frame) sum += sample.toDouble() * sample
      val rms = sqrt(sum / frame.size) / 32768.0
      return if (rms <= 0.0) -100.0 else 20 * log10(rms)
    }

    private fun join(frames: List<ShortArray>): ShortArray {
      val out = ShortArray(frames.sumOf { it.size })
      var offset = 0
      for (frame in frames) {
        frame.copyInto(out, offset)
        offset += frame.size
      }
      return out
    }
  }
}
