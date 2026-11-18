package expo.modules.t3voicemode

import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper

/**
 * Puts the phone in call mode, which turns on its echo cancellation, and chooses where the call is
 * heard: a connected headset, otherwise the loudspeaker. Call mode on its own plays through the
 * earpiece, and never reaches a Bluetooth headset unless the app selects it, so the choice is made
 * explicitly, and made again whenever a device connects or disconnects.
 */
internal class CallRoute(private val manager: AudioManager) {
  @Volatile private var previousMode: Int? = null
  private var watch: AudioDeviceCallback? = null

  val isUp: Boolean get() = previousMode != null

  @Synchronized
  fun bringUp() {
    if (previousMode == null) previousMode = manager.mode
    manager.mode = AudioManager.MODE_IN_COMMUNICATION
    choose()
    if (watch != null) return
    watch = object : AudioDeviceCallback() {
      override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = rechoose()
      override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = rechoose()
    }.also { manager.registerAudioDeviceCallback(it, Handler(Looper.getMainLooper())) }
  }

  @Synchronized
  fun tearDown() {
    val mode = previousMode ?: return
    watch?.let(manager::unregisterAudioDeviceCallback)
    watch = null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      manager.clearCommunicationDevice()
    } else {
      @Suppress("DEPRECATION")
      manager.stopBluetoothSco()
      @Suppress("DEPRECATION")
      manager.isBluetoothScoOn = false
      @Suppress("DEPRECATION")
      manager.isSpeakerphoneOn = false
    }
    manager.mode = mode
    previousMode = null
  }

  @Synchronized
  private fun rechoose() {
    if (previousMode != null) choose()
  }

  private fun choose() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val devices = manager.availableCommunicationDevices
      val type = preferredType(devices.map { it.type }) ?: return
      val device = devices.first { it.type == type }
      if (manager.communicationDevice?.id != device.id) manager.setCommunicationDevice(device)
    } else {
      chooseBeforeS()
    }
  }

  @Suppress("DEPRECATION")
  private fun chooseBeforeS() {
    val type = preferredType(manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).map { it.type })
    val bluetooth = type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
    if (bluetooth && !manager.isBluetoothScoOn) {
      manager.startBluetoothSco()
      manager.isBluetoothScoOn = true
    } else if (!bluetooth && manager.isBluetoothScoOn) {
      manager.stopBluetoothSco()
      manager.isBluetoothScoOn = false
    }
    manager.isSpeakerphoneOn = type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
  }

  companion object {
    // A plugged-in headset first, then a Bluetooth one, then the loudspeaker; never the earpiece.
    private val PREFERENCE = listOf(
      AudioDeviceInfo.TYPE_USB_HEADSET,
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_BLE_HEADSET,
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
    )

    /** The device type the call should use, from the types available. */
    fun preferredType(available: List<Int>): Int? = PREFERENCE.firstOrNull { it in available }
  }
}
