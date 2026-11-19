package expo.modules.t3voicemode

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.SystemClock
import android.util.Log
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.PI
import kotlin.math.sin

/**
 * The chimes heard when voice mode comes on, sends a message, and goes off: short sine notes, two
 * rising to start, one high blip when a message is sent, and two falling to stop. The web client
 * plays the same notes (VOICE_MODE_CHIME in client-runtime).
 */
internal enum class VoiceModeChime(private vararg val notesHz: Double) {
  START(660.0, 880.0),
  SENT(1320.0),
  STOP(880.0, 660.0);

  fun pcm(sampleRate: Int = SAMPLE_RATE): ShortArray {
    val noteSamples = sampleRate * NOTE_MS / 1000
    val attack = sampleRate * ATTACK_MS / 1000.0
    val release = sampleRate * RELEASE_MS / 1000.0
    return ShortArray(noteSamples * notesHz.size) { i ->
      val n = i % noteSamples
      // Ramps in and out, so the notes start and end without a click.
      val envelope = minOf(1.0, n / attack, (noteSamples - 1 - n) / release)
      val tone = sin(2 * PI * notesHz[i / noteSamples] * n / sampleRate)
      (tone * envelope * PEAK * Short.MAX_VALUE).toInt().toShort()
    }
  }

  /** Plays the chime with `usage`'s volume and route, and returns once it has been heard. */
  fun play(usage: Int) {
    val samples = pcm()
    val track = AudioTrack.Builder()
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(usage)
          .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
          .build()
      )
      .setAudioFormat(
        AudioFormat.Builder()
          .setSampleRate(SAMPLE_RATE)
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
          .build()
      )
      .setTransferMode(AudioTrack.MODE_STATIC)
      .setBufferSizeInBytes(samples.size * 2)
      .build()
    try {
      track.write(samples, 0, samples.size)
      track.play()
      val deadline =
        SystemClock.uptimeMillis() + samples.size * 1000L / SAMPLE_RATE + START_ALLOWANCE_MS
      while (track.playbackHeadPosition < samples.size && SystemClock.uptimeMillis() < deadline) {
        SystemClock.sleep(POLL_MS)
      }
      // The last samples are still on their way through the output when the head reaches the end.
      SystemClock.sleep(OUTPUT_TAIL_MS)
    } finally {
      track.release()
    }
  }

  companion object {
    const val SAMPLE_RATE = 48000
    const val NOTE_MS = 90
    private const val ATTACK_MS = 8
    private const val RELEASE_MS = 40
    private const val PEAK = 0.25

    /** How long an output that was asleep may take to start playing. */
    private const val START_ALLOWANCE_MS = 500L
    private const val POLL_MS = 10L
    private const val OUTPUT_TAIL_MS = 60L
  }
}

/** Plays chimes one after another, on a thread of their own. */
internal class ChimePlayer {
  private val thread = Executors.newSingleThreadExecutor { Thread(it, "T3VoiceModeChime") }
  private val pending = AtomicInteger()

  /** Whether a chime is queued or playing. */
  val playing: Boolean get() = pending.get() > 0

  fun play(chime: VoiceModeChime, usage: Int) {
    pending.incrementAndGet()
    thread.execute {
      try {
        chime.play(usage)
      } catch (@Suppress("TooGenericExceptionCaught") error: Exception) {
        // A chime that cannot play must not take voice mode down with it.
        Log.w(TAG, "Could not play the $chime chime.", error)
      } finally {
        pending.decrementAndGet()
      }
    }
  }

  /** Returns once every chime queued so far has played. */
  fun awaitQuiet() {
    thread.submit {}.get()
  }

  fun shutDown() {
    thread.shutdown()
  }

  private companion object {
    const val TAG = "T3VoiceMode"
  }
}
