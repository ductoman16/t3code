package expo.modules.t3voicemode

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * Voice mode's audio on Android: a call-style audio route, a microphone that finds utterances, and a
 * voice that reads replies. Everything else, from transcription to what is said, lives in JavaScript.
 */
class T3VoiceModeModule : Module() {
  private var microphone: VoiceModeMicrophone? = null

  @Volatile private var voice: VoiceModeVoice? = null

  private val route by lazy { CallRoute(audioManager) }
  private val chimes = ChimePlayer()
  private var watchdog: VoiceModeWatchdog.Watch? = null

  /** Read and written on the main thread only. */
  private var javaScriptTask: Int? = null

  private val context: Context get() = requireNotNull(appContext.reactContext)
  private val audioManager get() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  override fun definition() = ModuleDefinition {
    Name("T3VoiceMode")
    Events("onSpeech", "onVoice", "onHangUp")

    OnCreate {
      VoiceModeService.onHangUp = { sendEvent("onHangUp", emptyMap<String, Any?>()) }
    }

    AsyncFunction("startListening") { startListening() }

    AsyncFunction("stopListening") { stopListening() }

    AsyncFunction("prepareVoice") Coroutine suspend { prepareVoice() }

    Function("say") { id: String, text: String, rate: Double ->
      checkNotNull(voice) { "The voice is not ready." }.say(id, text, rate)
    }

    Function("stopSpeaking") { voice?.stop() }

    Function("shutDownVoice") {
      voice?.shutDown()
      voice = null
    }

    // Synchronous, so a stop chime is queued before the stopListening that follows it.
    Function("playChime") { name: String ->
      val chime = when (name) {
        "start" -> VoiceModeChime.START
        "stop" -> VoiceModeChime.STOP
        else -> throw IllegalArgumentException("There is no \"$name\" chime.")
      }
      // On the call's route while it is up, so the echo canceller hears it too.
      val usage = if (route.isUp) {
        AudioAttributes.USAGE_VOICE_COMMUNICATION
      } else {
        AudioAttributes.USAGE_MEDIA
      }
      chimes.play(chime, usage)
    }

    Function("deleteUtterance") { uri: String ->
      android.net.Uri.parse(uri).path?.let(::File)
        ?.takeIf { it.parentFile?.name == "voice-mode" }
        ?.delete()
    }

    OnDestroy {
      VoiceModeService.onHangUp = null
      // JavaScript, which chimes every other stop, is going away with this module.
      val listening = microphone != null
      if (listening) chimes.play(VoiceModeChime.STOP, AudioAttributes.USAGE_VOICE_COMMUNICATION)
      stopListening()
      voice?.shutDown()
      voice = null
      chimes.shutDown()
    }
  }

  private suspend fun prepareVoice() {
    val created = voice ?: VoiceModeVoice(context) { sendEvent("onVoice", it) }
    created.prepare()
    voice = created
  }

  private fun startListening() {
    if (microphone != null) return
    route.bringUp()
    val started = VoiceModeMicrophone(
      File(context.cacheDir, "voice-mode"),
      speechModel = { context.assets.open(SileroVad.ASSET).use { it.readBytes() } },
      talkingOver = { voice?.speaking == true || chimes.playing }
    ) { sendEvent("onSpeech", it) }
    try {
      started.start()
      VoiceModeService.start(context)
    } catch (@Suppress("TooGenericExceptionCaught") error: Exception) {
      started.stop()
      route.tearDown()
      throw error
    }
    microphone = started
    watchdog = VoiceModeWatchdog.Watch(context.applicationContext)
    keepJavaScriptRunning()
  }

  private fun stopListening() {
    microphone?.stop()
    microphone = null
    watchdog?.end()
    watchdog = null
    VoiceModeService.stop(context)
    UiThreadUtil.runOnUiThread {
      javaScriptTask?.let {
        HeadlessJsTaskContext.getInstance(context as ReactContext).finishTask(it)
      }
      javaScriptTask = null
    }
    // The stop chime, queued just before, plays on the call's route before it comes down.
    chimes.awaitQuiet()
    route.tearDown()
  }

  // React Native stops firing JavaScript timers once the app is paused, as it is with the screen
  // off, unless a headless task is running. This one lasts until listening stops.
  private fun keepJavaScriptRunning() {
    UiThreadUtil.runOnUiThread {
      if (javaScriptTask != null) return@runOnUiThread
      javaScriptTask = HeadlessJsTaskContext.getInstance(context as ReactContext).startTask(
        HeadlessJsTaskConfig(JAVASCRIPT_TASK, Arguments.createMap(), 0, true)
      )
    }
  }

  private companion object {
    const val JAVASCRIPT_TASK = "T3VoiceMode"
  }
}
