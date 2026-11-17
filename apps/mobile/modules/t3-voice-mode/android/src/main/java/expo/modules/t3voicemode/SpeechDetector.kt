package expo.modules.t3voicemode

import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Finds utterances in a stream of 16 kHz mono PCM16 frames by their loudness against the room's
 * background noise, which it keeps learning while nobody is talking.
 */
internal class SpeechDetector(
  private val frameMs: Int = 20,
  private val minSpeechMs: Int = 160,
  private val redemptionMs: Int = 600,
  private val preRollMs: Int = 300,
  private val maxUtteranceMs: Int = 30_000,
  /** How far above the background a frame must be to start an utterance. */
  private val onsetDb: Double = 12.0,
  /** How far above the background a frame must be to keep one going. */
  private val sustainDb: Double = 7.0,
  /** Quieter than this is never speech, however quiet the room. */
  private val floorLimitDb: Double = -58.0,
  /** Time spent learning the room before listening for speech. */
  private val warmUpMs: Int = 400,
  /** How much louder, and how much longer, speech must be while the agent's voice is playing. */
  private val talkOverExtraDb: Double = 10.0,
  private val talkOverMinSpeechMs: Int = 400,
  /** How long that stricter hearing lasts after the voice stops, while its echo dies away. */
  private val talkOverTailMs: Int = 500
) {
  sealed interface Event {
    data object Start : Event
    data object Confirmed : Event
    data object Cancel : Event
    class Utterance(val pcm: ShortArray) : Event
  }

  private var background = Double.NaN
  private var heardMs = 0
  private val preRoll = ArrayDeque<ShortArray>()
  private val utterance = ArrayList<ShortArray>()
  private var speaking = false
  private var confirmed = false
  private var speechMs = 0
  private var quietMs = 0
  private var requiredSpeechMs = minSpeechMs
  private var strictMs = 0

  /** Whether the agent's voice is playing, so its echo is not taken for the user. */
  var talkingOver = false

  fun process(frame: ShortArray): Event? {
    val level = levelDb(frame)
    strictMs = if (talkingOver) talkOverTailMs else max(strictMs - frameMs, 0)
    val strict = strictMs > 0
    if (heardMs < warmUpMs) {
      // The room's own noise, averaged, is where listening starts from.
      heardMs += frameMs
      val frames = heardMs / frameMs
      background = if (background.isNaN()) level else background + (level - background) / frames
      preRoll.addLast(frame)
      while (preRoll.size * frameMs > preRollMs) preRoll.removeFirst()
      return null
    }
    if (!speaking) {
      val onset = background + onsetDb + if (strict) talkOverExtraDb else 0.0
      if (level > max(onset, floorLimitDb)) {
        speaking = true
        confirmed = false
        requiredSpeechMs = if (strict) talkOverMinSpeechMs else minSpeechMs
        speechMs = frameMs
        quietMs = 0
        utterance.clear()
        utterance.addAll(preRoll)
        utterance.add(frame)
        preRoll.clear()
        return Event.Start
      }
      learnBackground(level, rise = 0.02)
      preRoll.addLast(frame)
      while (preRoll.size * frameMs > preRollMs) preRoll.removeFirst()
      return null
    }
    utterance.add(frame)
    learnBackground(level, rise = 0.001)
    if (level > max(background + sustainDb, floorLimitDb)) {
      speechMs += frameMs
      quietMs = 0
    } else {
      quietMs += frameMs
    }
    if (!confirmed && speechMs >= requiredSpeechMs) {
      confirmed = true
      return Event.Confirmed
    }
    if (quietMs >= redemptionMs || utterance.size * frameMs >= maxUtteranceMs) return finish()
    return null
  }

  /** Ends whatever is being heard, as when the microphone closes. */
  fun flush(): Event? = if (speaking) finish() else null

  private fun finish(): Event {
    speaking = false
    val event = if (confirmed) Event.Utterance(join(utterance)) else Event.Cancel
    utterance.clear()
    return event
  }

  // Falls quickly to a quieter room and rises slowly, and more slowly still while someone talks, so
  // a long sentence is not taken for noise while a steady hum soon is.
  private fun learnBackground(level: Double, rise: Double) {
    background += (level - background) * if (level < background) 0.3 else rise
  }

  companion object {
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
