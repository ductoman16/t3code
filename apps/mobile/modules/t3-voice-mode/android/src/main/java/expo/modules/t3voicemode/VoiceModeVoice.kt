package expo.modules.t3voicemode

import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale
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
    val created = TextToSpeech(context, { status -> ready.complete(status) }, preferredEngine())
    if (ready.await() != TextToSpeech.SUCCESS) {
      created.shutdown()
      error("This phone has no text-to-speech voice. Install one in Android's settings.")
    }
    chooseVoice(created)
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

  // Google's engine has more natural voices than some phones' own, such as Samsung's.
  private fun preferredEngine(): String? {
    val engines = context.packageManager.queryIntentServices(
      Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE),
      0
    )
    return GOOGLE_ENGINE.takeIf { engines.any { it.serviceInfo.packageName == GOOGLE_ENGINE } }
  }

  private fun chooseVoice(engine: TextToSpeech) {
    val voices = engine.voices.orEmpty()
    val options = voices.map {
      VoiceOption(
        name = it.name,
        language = it.locale.language,
        country = it.locale.country,
        quality = it.quality,
        offline = !it.isNetworkConnectionRequired &&
          TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED !in it.features,
        isDefault = it.name == engine.defaultVoice?.name
      )
    }
    val name = bestVoice(options, Locale.getDefault()) ?: return
    engine.voice = voices.first { it.name == name }
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

  private companion object {
    const val GOOGLE_ENGINE = "com.google.android.tts"
  }
}

/** What the voice is chosen by; a plain copy of the engine's own Voice, so it can be tested. */
internal data class VoiceOption(
  val name: String,
  val language: String,
  val country: String,
  val quality: Int,
  /** Installed on the phone, so a reply is never held up by the network. */
  val offline: Boolean,
  val isDefault: Boolean
)

/**
 * The best offline voice in the phone's language: its own country's first, then the highest
 * quality, then the engine's default.
 */
internal fun bestVoice(options: List<VoiceOption>, locale: Locale): String? = options
  .filter { it.offline && it.language == locale.language }
  .sortedWith(
    compareByDescending<VoiceOption> { it.country == locale.country }
      .thenByDescending { it.quality }
      .thenByDescending { it.isDefault }
  )
  .firstOrNull()?.name
