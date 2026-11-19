package expo.modules.t3voicemode

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Plays audio made elsewhere, sentence by sentence, on the voice-call stream so the microphone's
 * echo canceller and the call's route treat it like the phone's own voice. Sentences play back to
 * back; each reports when it starts and when it has been heard to the end. A stop reports nothing.
 */
internal class VoiceModePlayer(private val onEvent: (Map<String, Any?>) -> Unit) {
  private class Clip(val id: String, val audio: WavPcm, val generation: Int)

  private val clips = LinkedBlockingQueue<Clip>()
  private val lock = Any()

  // Guarded by lock. A stop releases the track, so a new one counts frames from zero again.
  private val timeline = PlaybackTimeline()
  private var track: AudioTrack? = null
  private var generation = 0

  @Volatile private var running = true

  /** Whether a sentence is playing now. Read from the microphone's thread. */
  @Volatile var speaking = false
    private set

  private val thread = Thread(::run, "T3VoiceModePlayer").apply { start() }

  fun play(id: String, wav: ByteArray) {
    val audio = WavPcm.parse(wav)
    synchronized(lock) { clips.add(Clip(id, audio, generation)) }
  }

  fun stop() {
    synchronized(lock) {
      generation += 1
      clips.clear()
      track?.run {
        pause()
        flush()
        release()
      }
      track = null
      timeline.clear()
      speaking = false
    }
  }

  fun shutDown() {
    running = false
    stop()
    thread.interrupt()
    thread.join(JOIN_MS)
  }

  private fun run() {
    try {
      while (running) {
        report()
        clips.poll(TICK_MS, TimeUnit.MILLISECONDS)?.let(::playOut)
      }
    } catch (_: InterruptedException) {
      // Shut down.
    } catch (@Suppress("TooGenericExceptionCaught") error: Exception) {
      stop()
      val message = error.message ?: "The phone could not play the voice."
      onEvent(mapOf("type" to "error", "message" to message))
    }
  }

  private fun playOut(clip: Clip) {
    // Without audio after it, some devices hold back the end of the last sentence.
    if (append(clip, clip.audio.pcm, clip.id) && clips.isEmpty()) {
      append(
        clip,
        ByteArray(clip.audio.sampleRate * TAIL_MS / MILLIS * WavPcm.BYTES_PER_FRAME),
        null
      )
    }
  }

  /** Writes all of `pcm` as sentence `id`, or as silence; false when a stop came first. */
  private fun append(clip: Clip, pcm: ByteArray, id: String?): Boolean {
    val current = synchronized(lock) {
      (clip.generation == generation).also { current ->
        if (current) {
          val target = trackFor(clip.audio.sampleRate)
          val frames = pcm.size / WavPcm.BYTES_PER_FRAME
          if (id == null) timeline.pad(frames) else timeline.add(id, frames)
          target.play()
        }
      }
    }
    var offset = 0
    var stopped = !current
    while (!stopped && offset < pcm.size) {
      val wrote = synchronized(lock) {
        if (clip.generation == generation) {
          checkNotNull(track).write(pcm, offset, pcm.size - offset, AudioTrack.WRITE_NON_BLOCKING)
        } else {
          null
        }
      }
      if (wrote == null) {
        stopped = true
      } else {
        check(wrote >= 0) { "The phone could not play the voice (error $wrote)." }
        offset += wrote
        report()
        if (wrote == 0) Thread.sleep(TICK_MS)
      }
    }
    return !stopped
  }

  private fun report() {
    val events = synchronized(lock) {
      val playing = track ?: return
      val happened = timeline.advance(playing.playbackHeadPosition.toLong() and FRAME_MASK)
      speaking = timeline.speaking
      happened
    }
    for (event in events) {
      val type = if (event is PlaybackTimeline.Event.Start) "start" else "done"
      onEvent(mapOf("type" to type, "id" to event.id))
    }
  }

  // Called with lock held.
  private fun trackFor(sampleRate: Int): AudioTrack {
    track?.let { current ->
      if (current.sampleRate == sampleRate) return current
      current.release()
      timeline.clear()
    }
    val minimum = AudioTrack.getMinBufferSize(
      sampleRate,
      AudioFormat.CHANNEL_OUT_MONO,
      AudioFormat.ENCODING_PCM_16BIT
    )
    check(minimum > 0) { "The phone cannot play audio at $sampleRate Hz." }
    val created = AudioTrack.Builder()
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()
      )
      .setAudioFormat(
        AudioFormat.Builder()
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .setSampleRate(sampleRate)
          .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
          .build()
      )
      .setTransferMode(AudioTrack.MODE_STREAM)
      .setBufferSizeInBytes(
        maxOf(minimum, sampleRate * WavPcm.BYTES_PER_FRAME * BUFFER_MS / MILLIS)
      )
      .build()
    track = created
    return created
  }

  private companion object {
    const val TICK_MS = 20L
    const val TAIL_MS = 200
    const val BUFFER_MS = 250
    const val MILLIS = 1000
    const val JOIN_MS = 1000L

    // The playback head is an unsigned 32-bit frame count.
    const val FRAME_MASK = 0xFFFFFFFFL
  }
}
