package com.skytron.platform.service
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.skytron.platform.MainActivity
import com.skytron.platform.ui.SystemAlertWidget
class AetherisForegroundService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null
    private var widget: SystemAlertWidget? = null
    private var monitor: ProactiveMonitor? = null
    private var voice: VoiceProcessor? = null
    override fun onCreate() {
        super.onCreate()
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "skytron:wakelock")
        wakeLock?.acquire(30 * 60 * 1000L)
        voice = VoiceProcessor(this)
        widget = SystemAlertWidget(this)
        monitor = ProactiveMonitor(this) { alert ->
            widget?.peek(alert.title, alert.message)
            voice?.speak("${alert.title}: ${alert.message}")
        }
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, "skytron_service")
            .setContentTitle("Skytron")
            .setContentText("Skytron is watching")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(pi)
            .setOngoing(true)
            .build()
        startForeground(1, notification)
        monitor?.start()
        return START_STICKY
    }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onDestroy() {
        monitor?.stop()
        widget?.destroy()
        voice?.shutdown()
        wakeLock?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }
}
