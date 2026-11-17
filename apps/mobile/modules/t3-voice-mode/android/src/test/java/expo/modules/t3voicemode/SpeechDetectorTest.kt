package expo.modules.t3voicemode

import kotlin.math.PI
import kotlin.math.sin
import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechDetectorTest {
  private val random = Random(7)

  /** A frame paired with the speech probability the model gives it. */
  private class Heard(val probability: Float, val frame: ShortArray)

  private val probabilities = ArrayDeque<Float>()
  private fun detector() = SpeechDetector(SpeechModel { probabilities.removeFirst() })

  /** 32 ms of a 220 Hz tone at `amplitude`, over faint noise. */
  private fun sound(amplitude: Double) = ShortArray(512) { i ->
    val tone = sin(2 * PI * 220 * i / 16000) * amplitude * 32767
    (tone + (random.nextDouble() - 0.5) * 60).toInt().toShort()
  }

  private fun heard(ms: Int, probability: Float, amplitude: Double = 0.2) =
    List(ms / 32) { Heard(probability, sound(amplitude)) }

  private fun speech(ms: Int) = heard(ms, 0.9f)
  private fun quiet(ms: Int) = heard(ms, 0.05f, amplitude = 0.0)

  private fun SpeechDetector.feed(frames: List<Heard>) = frames.mapNotNull {
    probabilities.addLast(it.probability)
    process(it.frame)
  }

  @Test
  fun hearsAShortWordAsAnUtterance() {
    val detector = detector()
    detector.feed(quiet(1000))

    val events = detector.feed(speech(256) + quiet(700))

    assertEquals(SpeechDetector.Event.Start, events[0])
    assertEquals(SpeechDetector.Event.Confirmed, events[1])
    val utterance = events[2] as SpeechDetector.Event.Utterance
    // The pre-roll, the word and the pause that ended it.
    assertEquals(512 * (9 + 8 + 18), utterance.pcm.size)
    assertEquals(3, events.size)
  }

  @Test
  fun ignoresALoudNoiseTheModelDoesNotTakeForSpeech() {
    val detector = detector()

    assertTrue(detector.feed(heard(3000, 0.3f, amplitude = 0.5)).isEmpty())
  }

  @Test
  fun ignoresNearSilenceHoweverLikelyTheModelThinksItIsSpeech() {
    val detector = detector()

    assertTrue(detector.feed(heard(1000, 0.9f, amplitude = 0.0)).isEmpty())
  }

  @Test
  fun dropsASoundTooShortToBeSpeech() {
    val detector = detector()
    detector.feed(quiet(1000))

    val events = detector.feed(speech(96) + quiet(700))

    assertEquals(listOf(SpeechDetector.Event.Start, SpeechDetector.Event.Cancel), events)
  }

  @Test
  fun keepsOneUtteranceThroughPausesAndUncertainFrames() {
    val detector = detector()
    detector.feed(quiet(1000))

    val events = detector.feed(
      speech(400) + quiet(300) + speech(400) + heard(1000, 0.4f) + speech(200) + quiet(700)
    )

    assertEquals(1, events.count { it is SpeechDetector.Event.Utterance })
    assertTrue(events.last() is SpeechDetector.Event.Utterance)
  }

  @Test
  fun flushEndsAnUtteranceInProgress() {
    val detector = detector()
    detector.feed(quiet(1000) + speech(400))

    assertTrue(detector.flush() is SpeechDetector.Event.Utterance)
  }

  @Test
  fun ignoresTheVoicesEchoAndUncertainSoundsWhileItPlays() {
    val echo = { heard(1000, 0.9f, amplitude = 0.005) }
    val uncertain = { heard(1000, 0.6f) }
    val listening = detector()
    val talkingOver = detector()
    talkingOver.talkingOver = true

    assertEquals(SpeechDetector.Event.Start, listening.feed(echo()).first())
    listening.flush()
    assertEquals(SpeechDetector.Event.Start, listening.feed(uncertain()).first())
    assertTrue(talkingOver.feed(echo() + uncertain()).isEmpty())
  }

  @Test
  fun dropsAShortWordHeardWhileTheVoicePlays() {
    val detector = detector()
    detector.feed(quiet(1000))
    detector.talkingOver = true

    val events = detector.feed(speech(256) + quiet(700))

    assertEquals(listOf(SpeechDetector.Event.Start, SpeechDetector.Event.Cancel), events)
  }

  @Test
  fun hearsTheUserTalkingOverTheVoice() {
    val detector = detector()
    detector.feed(quiet(1000))
    detector.talkingOver = true

    val events = detector.feed(speech(600) + quiet(700))

    assertEquals(SpeechDetector.Event.Start, events[0])
    assertEquals(SpeechDetector.Event.Confirmed, events[1])
    assertTrue(events[2] is SpeechDetector.Event.Utterance)
  }

  @Test
  fun listensNormallyAgainOnceTheVoiceHasStopped() {
    val detector = detector()
    detector.feed(quiet(1000))
    detector.talkingOver = true
    detector.feed(quiet(1000))
    detector.talkingOver = false

    val duringTail = detector.feed(speech(256) + quiet(700))
    val after = detector.feed(speech(256) + quiet(700))

    assertEquals(listOf(SpeechDetector.Event.Start, SpeechDetector.Event.Cancel), duringTail)
    assertEquals(SpeechDetector.Event.Confirmed, after[1])
    assertTrue(after[2] is SpeechDetector.Event.Utterance)
  }
}
