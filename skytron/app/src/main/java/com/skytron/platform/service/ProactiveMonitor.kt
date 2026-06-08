package com.skytron.platform.service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Handler
import android.os.Looper
import com.skytron.platform.data.AppDatabase
import com.skytron.platform.data.ReminderEntity
data class ProactiveAlert(val title: String, val message: String, val priority: Int)
class ProactiveMonitor(
    private val ctx: Context,
    private val onAlert: (ProactiveAlert) -> Unit
) {
    private val handler = Handler(Looper.getMainLooper())
    private var lastBatteryPct = 100
    fun start() {
        checkBattery()
        checkReminders()
        handler.postDelayed({
            checkBattery()
            checkReminders()
            handler.postDelayed({ start() }, 30000)
        }, 5000)
    }
    private fun checkBattery() {
        val intent = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, 0) ?: return
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
        val pct = level * 100 / scale
        if (pct <= 15 && lastBatteryPct > 15)
            onAlert(ProactiveAlert("Battery", "Battery is at $pct% — charge soon", 1))
        if (pct <= 5 && lastBatteryPct > 5)
            onAlert(ProactiveAlert("Battery", "Battery critically low at $pct%", 2))
        if (pct == 100 && lastBatteryPct < 100)
            onAlert(ProactiveAlert("Battery", "Battery fully charged", 1))
        lastBatteryPct = pct
    }
    private fun checkReminders() {
        Thread {
            try {
                val db = AppDatabase.get(ctx)
                val now = System.currentTimeMillis()
                kotlinx.coroutines.runBlocking(kotlinx.coroutines.Dispatchers.IO) {
                    val due = db.reminderDao().due(now)
                    for (r in due) {
                        onAlert(ProactiveAlert("Reminder", r.text, 1))
                        db.reminderDao().markDone(r.id)
                    }
                }
            } catch (_: Exception) {}
        }.start()
    }
    fun stop() { handler.removeCallbacksAndMessages(null) }
}
