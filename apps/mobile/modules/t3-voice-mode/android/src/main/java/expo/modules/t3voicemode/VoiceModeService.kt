package expo.modules.t3voicemode

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Keeps voice mode's microphone and voice running with the screen off, like a phone call. Android
 * only lets a backgrounded app keep the microphone from a foreground service.
 */
class VoiceModeService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  @SuppressLint("WakelockTimeout") // Held for the call, released when the service stops.
  override fun onCreate() {
    super.onCreate()
    wakeLock = getSystemService(PowerManager::class.java)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "T3Code:VoiceMode")
      .apply {
        setReferenceCounted(false)
        acquire()
      }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_HANG_UP) {
      onHangUp?.invoke() ?: stopSelf()
      return START_NOT_STICKY
    }
    ServiceCompat.startForeground(
      this,
      NOTIFICATION_ID,
      notification(),
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
      } else {
        0
      }
    )
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    wakeLock?.release()
    wakeLock = null
    super.onDestroy()
  }

  // Without notification permission Android hides this, and the service still runs.
  private fun notification(): Notification {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(CHANNEL, "Voice mode", NotificationManager.IMPORTANCE_LOW)
      )
    }
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE)
    }
    val hangUp = PendingIntent.getService(
      this,
      0,
      Intent(this, VoiceModeService::class.java).setAction(ACTION_HANG_UP),
      PendingIntent.FLAG_IMMUTABLE
    )
    return NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.voice_mode_call)
      .setContentTitle("Voice mode is on")
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .setOngoing(true)
      .setSilent(true)
      .setShowWhen(false)
      .setContentIntent(open)
      .addAction(0, "Hang up", hangUp)
      .build()
  }

  companion object {
    private const val CHANNEL = "voice-mode"
    private const val NOTIFICATION_ID = 73101
    private const val ACTION_HANG_UP = "expo.modules.t3voicemode.HANG_UP"

    /** Called when the notification's Hang up is tapped. */
    @Volatile var onHangUp: (() -> Unit)? = null

    /** Must be called while the app is on screen: Android refuses a microphone service otherwise. */
    fun start(context: Context) {
      ContextCompat.startForegroundService(context, Intent(context, VoiceModeService::class.java))
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, VoiceModeService::class.java))
    }
  }
}
