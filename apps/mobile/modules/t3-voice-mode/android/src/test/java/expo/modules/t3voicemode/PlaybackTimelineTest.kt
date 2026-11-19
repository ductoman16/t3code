package expo.modules.t3voicemode

import expo.modules.t3voicemode.PlaybackTimeline.Event.Done
import expo.modules.t3voicemode.PlaybackTimeline.Event.Start
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaybackTimelineTest {
  @Test
  fun startsAndEndsSentencesAsPlaybackReachesThem() {
    val timeline = PlaybackTimeline()
    timeline.add("one", 100)
    timeline.add("two", 50)

    assertEquals(emptyList<PlaybackTimeline.Event>(), timeline.advance(0))
    assertFalse(timeline.speaking)
    assertEquals(listOf(Start("one")), timeline.advance(1))
    assertTrue(timeline.speaking)
    assertEquals(listOf(Done("one"), Start("two")), timeline.advance(120))
    assertEquals(listOf(Done("two")), timeline.advance(150))
    assertFalse(timeline.speaking)
    assertTrue(timeline.idle)
  }

  @Test
  fun reportsASentenceHeardWithinOneTickAsStartedThenDone() {
    val timeline = PlaybackTimeline()
    timeline.add("short", 10)
    timeline.pad(50)

    assertEquals(listOf(Start("short"), Done("short")), timeline.advance(40))
  }

  @Test
  fun placesTheNextSentenceAfterTrailingSilence() {
    val timeline = PlaybackTimeline()
    timeline.add("one", 100)
    timeline.pad(20)
    timeline.add("two", 30)

    timeline.advance(100)
    assertEquals(emptyList<PlaybackTimeline.Event>(), timeline.advance(120))
    assertEquals(listOf(Start("two")), timeline.advance(121))
  }

  @Test
  fun forgetsEverythingOnClear() {
    val timeline = PlaybackTimeline()
    timeline.add("one", 100)
    timeline.clear()

    assertEquals(0L, timeline.written)
    assertEquals(emptyList<PlaybackTimeline.Event>(), timeline.advance(500))
  }

  @Test
  fun readsSixteenBitMonoWav() {
    val wav = wav(sampleRate = 24_000, channels = 1, bits = 16, samples = byteArrayOf(1, 2, 3, 4))
    val parsed = WavPcm.parse(wav)

    assertEquals(24_000, parsed.sampleRate)
    assertEquals(2, parsed.frames)
    assertArrayEquals(byteArrayOf(1, 2, 3, 4), parsed.pcm)
  }

  @Test
  fun skipsChunksItDoesNotNeed() {
    val wav = wav(24_000, 1, 16, byteArrayOf(5, 6), extraChunk = "LIST")
    assertArrayEquals(byteArrayOf(5, 6), WavPcm.parse(wav).pcm)
  }

  @Test
  fun refusesAudioItCannotPlay() {
    assertThrows(IllegalArgumentException::class.java) {
      WavPcm.parse(wav(24_000, 2, 16, byteArrayOf(1, 2, 3, 4)))
    }
    assertThrows(IllegalArgumentException::class.java) {
      WavPcm.parse(wav(24_000, 1, 8, byteArrayOf(1, 2)))
    }
    assertThrows(IllegalArgumentException::class.java) {
      WavPcm.parse("not audio at all".toByteArray())
    }
    assertThrows(IllegalArgumentException::class.java) {
      WavPcm.parse(wav(24_000, 1, 16, byteArrayOf(1, 2, 3, 4)).copyOf(46))
    }
  }

  private fun wav(
    sampleRate: Int,
    channels: Int,
    bits: Int,
    samples: ByteArray,
    extraChunk: String? = null
  ): ByteArray {
    val extra = if (extraChunk == null) 0 else EXTRA_CHUNK_SIZE
    val size = HEADER + extra + samples.size
    val buffer = ByteBuffer.allocate(size).order(ByteOrder.LITTLE_ENDIAN)
    buffer.put("RIFF".toByteArray()).putInt(size - 8).put("WAVE".toByteArray())
    if (extraChunk != null) buffer.put(extraChunk.toByteArray()).putInt(2).put(byteArrayOf(0, 0))
    val frame = channels * bits / 8
    buffer.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(channels.toShort())
    buffer.putInt(sampleRate).putInt(sampleRate * frame).putShort(frame.toShort())
    buffer.putShort(bits.toShort())
    buffer.put("data".toByteArray()).putInt(samples.size).put(samples)
    return buffer.array()
  }

  private companion object {
    const val HEADER = 44
    const val EXTRA_CHUNK_SIZE = 10
  }
}
