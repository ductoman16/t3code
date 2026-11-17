package expo.modules.t3voicemode

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
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
  private var previousMode: Int? = null

  private val context: Context get() = requireNotNull(appContext.reactContext)
  private val audioManager get() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  override fun definition() = ModuleDefinition {
    Name("T3VoiceMode")
    Events("onSpeech", "onVoice")

    AsyncFunction("startListening") { startListening() }

    AsyncFunction("stopListening") {
      microphone?.stop()
      microphone = null
      restoreRoute()
    }

    AsyncFunction("prepareVoice") Coroutine { ->
      val created = voice ?: VoiceModeVoice(context) { sendEvent("onVoice", it) }
      created.prepare()
      voice = created
    }

    Function("say") { id: String, text: String, rate: Double ->
      checkNotNull(voice) { "The voice is not ready." }.say(id, text, rate)
    }

    Function("stopSpeaking") { voice?.stop() }

    Function("shutDownVoice") {
      voice?.shutDown()
      voice = null
    }

    Function("deleteUtterance") { uri: String ->
      android.net.Uri.parse(uri).path?.let(::File)
        ?.takeIf { it.parentFile?.name == "voice-mode" }
        ?.delete()
    }

    OnDestroy {
      microphone?.stop()
      microphone = null
      voice?.shutDown()
      voice = null
      restoreRoute()
    }
  }

  private fun startListening() {
    if (microphone != null) return
    routeLikeACall()
    val started = VoiceModeMicrophone(
      File(context.cacheDir, "voice-mode"),
      talkingOver = { voice?.speaking == true }
    ) { sendEvent("onSpeech", it) }
    try {
      started.start()
    } catch (@Suppress("TooGenericExceptionCaught") error: Exception) {
      restoreRoute()
      throw error
    }
    microphone = started
  }

  // Call mode turns on the phone's echo cancellation. It plays through the earpiece by default, so
  // the loudspeaker is chosen unless a headset is connected.
  private fun routeLikeACall() {
    val manager = audioManager
    if (previousMode == null) previousMode = manager.mode
    manager.mode = AudioManager.MODE_IN_COMMUNICATION
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val devices = manager.availableCommunicationDevices
      if (devices.none { it.type in HEADSET_TYPES }) {
        devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
          ?.let(manager::setCommunicationDevice)
      }
    } else {
      @Suppress("DEPRECATION")
      manager.isSpeakerphoneOn = !manager.isWiredHeadsetOn && !manager.isBluetoothScoOn
    }
  }

  private fun restoreRoute() {
    val mode = previousMode ?: return
    val manager = audioManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      manager.clearCommunicationDevice()
    } else {
      @Suppress("DEPRECATION")
      manager.isSpeakerphoneOn = false
    }
    manager.mode = mode
    previousMode = null
  }

  private companion object {
    val HEADSET_TYPES = setOf(
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      AudioDeviceInfo.TYPE_BLE_HEADSET,
      AudioDeviceInfo.TYPE_USB_HEADSET
    )
  }
}
