package com.skytron.platform
import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
class SkytronApp : Application() {
    override fun onCreate() {
        super.onCreate()
        instance = this
        createNotificationChannels()
    }
    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                "skytron_service", "Skytron Background",
                NotificationManager.IMPORTANCE_LOW
            ).apply { description = "Keeps Skytron alive" }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(ch)
        }
    }
    companion object {
        lateinit var instance: SkytronApp
            private set
    }
}
