package expo.modules.t3voicemode

import java.nio.ByteBuffer
import java.nio.ByteOrder

/** 16-bit mono PCM from a WAV file, as voice mode's environment voice sends it. */
internal class WavPcm(val sampleRate: Int, val pcm: ByteArray) {
  val frames: Int get() = pcm.size / BYTES_PER_FRAME

  companion object {
    const val BYTES_PER_FRAME = 2
    private const val RIFF_HEADER = 12
    private const val CHUNK_HEADER = 8
    private const val PCM_FORMAT = 1
    private const val BITS = 16

    fun parse(bytes: ByteArray): WavPcm {
      val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
      require(bytes.size >= RIFF_HEADER && tag(bytes, 0) == "RIFF" && tag(bytes, 8) == "WAVE") {
        "The voice sent audio that is not a WAV file."
      }
      var sampleRate = 0
      var position = RIFF_HEADER
      while (position + CHUNK_HEADER <= bytes.size) {
        val name = tag(bytes, position)
        val size = buffer.getInt(position + 4)
        val body = position + CHUNK_HEADER
        require(size >= 0 && body + size <= bytes.size) { "The voice sent a cut-off WAV file." }
        when (name) {
          "fmt " -> {
            val format = buffer.getShort(body).toInt()
            val channels = buffer.getShort(body + 2).toInt()
            val bits = buffer.getShort(body + 14).toInt()
            require(format == PCM_FORMAT && channels == 1 && bits == BITS) {
              "The voice sent audio that is not 16-bit mono."
            }
            sampleRate = buffer.getInt(body + 4)
          }
          "data" -> {
            require(sampleRate > 0) { "The voice sent a WAV file without a format." }
            val length = size - size % BYTES_PER_FRAME
            return WavPcm(sampleRate, bytes.copyOfRange(body, body + length))
          }
        }
        position = body + size + size % 2
      }
      throw IllegalArgumentException("The voice sent a WAV file without audio.")
    }

    private fun tag(bytes: ByteArray, at: Int) = String(bytes, at, 4, Charsets.US_ASCII)
  }
}

/**
 * Which sentence the speaker is sounding, from how far playback has got through the audio written.
 * Sentences are written back to back; each starts when playback reaches its first frame.
 */
internal class PlaybackTimeline {
  private class Segment(
    val id: String,
    val start: Long,
    val end: Long,
    var started: Boolean = false
  )

  sealed interface Event {
    val id: String
    data class Start(override val id: String) : Event
    data class Done(override val id: String) : Event
  }

  private val segments = ArrayDeque<Segment>()

  /** Frames written so far; the next sentence starts here. */
  var written = 0L
    private set

  /** A sentence has started and not yet ended. */
  val speaking: Boolean get() = segments.firstOrNull()?.started == true

  val idle: Boolean get() = segments.isEmpty()

  fun add(id: String, frames: Int) {
    segments.addLast(Segment(id, written, written + frames))
    written += frames
  }

  /** Silence written after the last sentence, so the end of it is played out. */
  fun pad(frames: Int) {
    written += frames
  }

  /** The starts and ends that playback reaching `head` frames has passed, in order. */
  fun advance(head: Long): List<Event> {
    val events = mutableListOf<Event>()
    while (segments.isNotEmpty()) {
      val segment = segments.first()
      if (!segment.started && head > segment.start) {
        segment.started = true
        events += Event.Start(segment.id)
      }
      if (head < segment.end) break
      if (!segment.started) events += Event.Start(segment.id)
      events += Event.Done(segment.id)
      segments.removeFirst()
    }
    return events
  }

  /** Forgets everything; playback starts again from frame 0. */
  fun clear() {
    segments.clear()
    written = 0
  }
}
