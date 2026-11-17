package expo.modules.t3voicemode

import android.content.Context
import android.media.AudioAttributes
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import kotlinx.coroutines.CompletableDeferred

/**
 * Android's text-to-speech, on the voice-call stream so the microphone's echo canceller knows what
 * it is saying. Sentences queue in order; each reports when it starts and when it is over.
 */
internal class VoiceModeVoice(
  private val context: Context,
  private val onEvent: (Map<String, Any?>) -> Unit
) {
  private var engine: TextToSpeech? = null

  /** Whether a sentence is playing now. Read from the microphone's thread. */
  @Volatile var speaking = false
    private set

  suspend fun prepare() {
    if (engine != null) return
    val ready = CompletableDeferred<Int>()
    val created = TextToSpeech(context) { status -> ready.complete(status) }
    if (ready.await() != TextToSpeech.SUCCESS) {
      created.shutdown()
      error("This phone has no text-to-speech voice. Install one in Android's settings.")
    }
    created.setAudioAttributes(
      AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
    )
    created.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(id: String) {
        speaking = true
        onEvent(mapOf("type" to "start", "id" to id))
      }
      override fun onDone(id: String) = done(id)
      override fun onStop(id: String, interrupted: Boolean) = done(id)
      @Deprecated("Replaced by onError(String, Int)")
      override fun onError(id: String) = done(id)
      override fun onError(id: String, code: Int) = done(id)
    })
    engine = created
  }

  private fun done(id: String) {
    speaking = false
    onEvent(mapOf("type" to "done", "id" to id))
  }

  fun say(id: String, text: String, rate: Double) {
    val voice = checkNotNull(engine) { "The voice is not ready." }
    voice.setSpeechRate(rate.toFloat())
    if (voice.speak(text, TextToSpeech.QUEUE_ADD, Bundle(), id) != TextToSpeech.SUCCESS) {
      onEvent(mapOf("type" to "done", "id" to id))
    }
  }

  fun stop() {
    engine?.stop()
    speaking = false
  }

  fun shutDown() {
    engine?.shutdown()
    engine = null
    speaking = false
  }
}
