package expo.modules.t3voicemode

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import java.io.File
import java.io.RandomAccessFile
import java.util.UUID

/**
 * Listens on the voice-call input, whose echo cancellation keeps the agent's own voice out, and
 * writes each utterance the detector finds to a WAV file.
 */
internal class VoiceModeMicrophone(
  private val directory: File,
  private val onEvent: (Map<String, Any?>) -> Unit
) {
  private var record: AudioRecord? = null
  private var effects: List<android.media.audiofx.AudioEffect> = emptyList()
  private var thread: Thread? = null
  @Volatile private var running = false

  @SuppressLint("MissingPermission") // The app asks for the microphone before it starts voice mode.
  fun start() {
    check(record == null) { "Voice mode is already listening." }
    val minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL, ENCODING)
    check(minimum > 0) { "This phone cannot record at 16 kHz." }
    val audio = AudioRecord(
      MediaRecorder.AudioSource.VOICE_COMMUNICATION,
      SAMPLE_RATE,
      CHANNEL,
      ENCODING,
      maxOf(minimum, SAMPLE_RATE * 2)
    )
    if (audio.state != AudioRecord.STATE_INITIALIZED) {
      audio.release()
      error("The microphone could not be opened.")
    }
    effects = listOfNotNull(
      if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(audio.audioSessionId) else null,
      if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(audio.audioSessionId) else null
    ).onEach { it.enabled = true }
    directory.mkdirs()
    audio.startRecording()
    record = audio
    running = true
    thread = Thread({ listen(audio) }, "T3VoiceModeMicrophone").also { it.start() }
  }

  fun stop() {
    running = false
    thread?.join(1000)
    thread = null
    record?.run {
      stop()
      release()
    }
    record = null
    effects.forEach { it.release() }
    effects = emptyList()
  }

  private fun listen(audio: AudioRecord) {
    val detector = SpeechDetector()
    val frame = ShortArray(FRAME_SAMPLES)
    try {
      while (running) {
        var filled = 0
        while (filled < frame.size && running) {
          val read = audio.read(frame, filled, frame.size - filled)
          check(read >= 0) { "The microphone stopped working (error $read)." }
          filled += read
        }
        if (!running) break
        detector.process(frame.copyOf())?.let(::report)
      }
    } catch (@Suppress("TooGenericExceptionCaught") error: Exception) {
      // Reported rather than thrown: this thread has no caller to throw to.
      if (running) onEvent(mapOf("type" to "error", "message" to (error.message ?: "Microphone failed.")))
    }
  }

  private fun report(event: SpeechDetector.Event) {
    when (event) {
      SpeechDetector.Event.Start -> onEvent(mapOf("type" to "start"))
      SpeechDetector.Event.Confirmed -> onEvent(mapOf("type" to "confirmed"))
      SpeechDetector.Event.Cancel -> onEvent(mapOf("type" to "cancel"))
      is SpeechDetector.Event.Utterance -> {
        val file = File(directory, "${UUID.randomUUID()}.wav")
        writeWav(file, event.pcm)
        onEvent(mapOf("type" to "utterance", "uri" to android.net.Uri.fromFile(file).toString()))
      }
    }
  }

  companion object {
    const val SAMPLE_RATE = 16000
    private const val FRAME_SAMPLES = 320
    private const val CHANNEL = AudioFormat.CHANNEL_IN_MONO
    private const val ENCODING = AudioFormat.ENCODING_PCM_16BIT

    fun writeWav(file: File, pcm: ShortArray) {
      val dataBytes = pcm.size * 2
      RandomAccessFile(file, "rw").use { out ->
        out.setLength(0)
        val header = java.nio.ByteBuffer.allocate(44).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        header.put("RIFF".toByteArray()).putInt(36 + dataBytes).put("WAVE".toByteArray())
        header.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1)
        header.putInt(SAMPLE_RATE).putInt(SAMPLE_RATE * 2).putShort(2).putShort(16)
        header.put("data".toByteArray()).putInt(dataBytes)
        out.write(header.array())
        val body = java.nio.ByteBuffer.allocate(dataBytes).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        body.asShortBuffer().put(pcm)
        out.write(body.array())
      }
    }
  }
}
