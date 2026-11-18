package expo.modules.t3voicemode

import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.media.AudioAttributes
import android.media.AudioManager
import android.os.Binder
import android.os.IBinder
import android.os.Parcel
import android.os.RemoteException
import android.os.SystemClock

/**
 * Chimes the stop when the app's process dies during a call, as it does on a native crash, which
 * leaves nothing in that process to play it. It runs in a process of its own (":voiceWatchdog"),
 * bound by the app for the length of the call. A normal stop chimes from the app and stands the
 * watchdog down before unbinding, so every stop is heard once.
 */
class VoiceModeWatchdog : Service() {
  @Volatile private var standingDown = false

  override fun onBind(intent: Intent?): IBinder {
    standingDown = false
    return object : Binder() {
      override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
        if (code != STAND_DOWN) return super.onTransact(code, data, reply, flags)
        standingDown = true
        return true
      }
    }
  }

  // Android drops a dead process's bindings, so an unbind without a stand-down means the app died.
  override fun onUnbind(intent: Intent?): Boolean {
    if (!standingDown) {
      awaitCallModeReleased()
      VoiceModeChime.STOP.play(AudioAttributes.USAGE_MEDIA)
    }
    return false
  }

  // Android ends the dead app's call mode itself. The chime waits for that, so it is not routed
  // for a call that is gone.
  private fun awaitCallModeReleased() {
    val audio = getSystemService(AudioManager::class.java)
    val deadline = SystemClock.uptimeMillis() + CALL_MODE_RELEASE_MS
    while (audio.mode == AudioManager.MODE_IN_COMMUNICATION &&
      SystemClock.uptimeMillis() < deadline
    ) {
      SystemClock.sleep(POLL_MS)
    }
  }

  /** The app's side of the watch, from the moment the microphone opens until it closes. */
  internal class Watch(private val context: Context) : ServiceConnection {
    private var service: IBinder? = null
    private var ended = false

    init {
      val intent = Intent(context, VoiceModeWatchdog::class.java)
      // Unwatched, a call loses only the chime after a crash.
      if (!context.bindService(intent, this, Context.BIND_AUTO_CREATE)) context.unbindService(this)
    }

    @Synchronized
    override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
      service = binder
      if (ended) standDown()
    }

    @Synchronized
    override fun onServiceDisconnected(name: ComponentName?) {
      service = null
    }

    /** Ends the watch without a chime; the app plays its own. */
    @Synchronized
    fun end() {
      if (ended) return
      ended = true
      // Not connected yet: the watchdog is stood down as soon as it is.
      if (service != null) standDown()
    }

    private fun standDown() {
      val data = Parcel.obtain()
      try {
        service?.transact(STAND_DOWN, data, null, 0)
      } catch (_: RemoteException) {
        // The watchdog's process is gone, so it has nothing to stand down.
      } finally {
        data.recycle()
      }
      service = null
      context.unbindService(this)
    }
  }

  private companion object {
    const val STAND_DOWN = IBinder.FIRST_CALL_TRANSACTION
    const val CALL_MODE_RELEASE_MS = 1500L
    const val POLL_MS = 20L
  }
}
