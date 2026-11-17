package expo.modules.t3voicemode

import kotlin.math.PI
import kotlin.math.sin
import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechDetectorTest {
  private val random = Random(7)

  /** 20 ms of a 220 Hz tone at `amplitude`, over faint noise. */
  private fun voice(amplitude: Double) = ShortArray(320) { i ->
    (sin(2 * PI * 220 * i / 16000) * amplitude * 32767 + noiseSample()).toInt().toShort()
  }

  private fun quiet() = ShortArray(320) { noiseSample().toInt().toShort() }

  private fun noiseSample() = (random.nextDouble() - 0.5) * 60

  private fun SpeechDetector.feed(frames: List<ShortArray>) = frames.mapNotNull { process(it) }

  private fun repeat(ms: Int, frame: () -> ShortArray) = List(ms / 20) { frame() }

  @Test
  fun hearsAShortWordAsAnUtterance() {
    val detector = SpeechDetector()
    detector.feed(repeat(1000) { quiet() })

    val events = detector.feed(repeat(240) { voice(0.2) } + repeat(700) { quiet() })

    assertEquals(SpeechDetector.Event.Start, events[0])
    assertEquals(SpeechDetector.Event.Confirmed, events[1])
    val utterance = events[2] as SpeechDetector.Event.Utterance
    // The pre-roll, the word and the pause that ended it.
    assertTrue(utterance.pcm.size >= 16 * (300 + 240 + 600))
    assertEquals(3, events.size)
  }

  @Test
  fun dropsAClickTooShortToBeSpeech() {
    val detector = SpeechDetector()
    detector.feed(repeat(1000) { quiet() })

    val events = detector.feed(repeat(60) { voice(0.3) } + repeat(700) { quiet() })

    assertEquals(listOf(SpeechDetector.Event.Start, SpeechDetector.Event.Cancel), events)
  }

  @Test
  fun keepsOneUtteranceThroughAShortPauseBetweenWords() {
    val detector = SpeechDetector()
    detector.feed(repeat(1000) { quiet() })

    val events = detector.feed(
      repeat(400) { voice(0.2) } + repeat(300) { quiet() } + repeat(400) { voice(0.2) } +
        repeat(700) { quiet() }
    )

    assertEquals(1, events.count { it is SpeechDetector.Event.Utterance })
  }

  @Test
  fun learnsAHumAsBackgroundRatherThanSpeech() {
    val detector = SpeechDetector()

    val events = detector.feed(repeat(5000) { voice(0.01) })
    val afterHum = detector.feed(repeat(100) { voice(0.01) })

    assertTrue(events.size <= 3)
    assertTrue(afterHum.isEmpty())
  }

  @Test
  fun startsFromTheRoomsNoiseRatherThanTakingItForSpeech() {
    val detector = SpeechDetector()

    val events = detector.feed(repeat(2000) { voice(0.01) })

    assertTrue(events.isEmpty())
  }

  @Test
  fun flushEndsAnUtteranceInProgress() {
    val detector = SpeechDetector()
    detector.feed(repeat(1000) { quiet() } + repeat(400) { voice(0.2) })

    assertTrue(detector.flush() is SpeechDetector.Event.Utterance)
  }
}
