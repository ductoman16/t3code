package expo.modules.t3voicemode

import android.media.AudioDeviceInfo.TYPE_BLE_HEADSET
import android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO
import android.media.AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
import android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
import android.media.AudioDeviceInfo.TYPE_WIRED_HEADPHONES
import android.media.AudioDeviceInfo.TYPE_WIRED_HEADSET
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CallRouteTest {
  private val phone = listOf(TYPE_BUILTIN_EARPIECE, TYPE_BUILTIN_SPEAKER)

  @Test
  fun usesTheLoudspeakerWithNoHeadset() {
    assertEquals(TYPE_BUILTIN_SPEAKER, CallRoute.preferredType(phone))
  }

  @Test
  fun usesABluetoothHeadset() {
    assertEquals(TYPE_BLUETOOTH_SCO, CallRoute.preferredType(phone + TYPE_BLUETOOTH_SCO))
    assertEquals(TYPE_BLE_HEADSET, CallRoute.preferredType(phone + TYPE_BLE_HEADSET))
  }

  @Test
  fun prefersAPluggedInHeadsetOverBluetooth() {
    assertEquals(
      TYPE_WIRED_HEADPHONES,
      CallRoute.preferredType(phone + TYPE_BLUETOOTH_SCO + TYPE_WIRED_HEADPHONES)
    )
    assertEquals(TYPE_WIRED_HEADSET, CallRoute.preferredType(phone + TYPE_WIRED_HEADSET))
  }

  @Test
  fun neverChoosesTheEarpiece() {
    assertNull(CallRoute.preferredType(listOf(TYPE_BUILTIN_EARPIECE)))
  }
}
