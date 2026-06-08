package com.skytron.platform.engine
import android.content.Context
import android.content.Intent
import android.location.LocationManager
import android.net.Uri
import android.provider.Settings
import com.skytron.platform.data.AppDatabase
import com.skytron.platform.data.ReminderEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.jsoup.Jsoup
data class ToolResult(val success: Boolean, val output: String)
class ToolExecutor(private val ctx: Context) {
    private val dynamicTools = mutableMapOf<String, (String) -> ToolResult>()
    fun registerDynamic(name: String, handler: (String) -> ToolResult) {
        dynamicTools[name] = handler
    }
    fun execute(tool: String, input: String): ToolResult = when (tool) {
        "web_search" -> webSearch(input)
        "open_app" -> openApp(input)
        "get_location" -> getLocation()
        "take_screenshot" -> takeScreenshot()
        "set_timer" -> setTimer(input)
        "set_reminder" -> setReminder(input)
        "get_reminders" -> getReminders()
        else -> dynamicTools[tool]?.invoke(input) ?: ToolResult(false, "Unknown tool: $tool")
    }
    private fun webSearch(query: String): ToolResult = try {
        val doc = Jsoup.connect("https://lite.duckduckgo.com/lite/?q=${Uri.encode(query)}")
            .userAgent("Mozilla/5.0").timeout(10000).get()
        val results = doc.select("tr.result-highlight, tr.result")
            .take(5).joinToString("\n") { it.text() }
        if (results.isBlank()) ToolResult(false, "no results")
        else ToolResult(true, results)
    } catch (e: Exception) {
        ToolResult(false, "search failed: ${e.message}")
    }
    private fun openApp(pkg: String): ToolResult = try {
        val intent = ctx.packageManager.getLaunchIntentForPackage(pkg.trim())
        if (intent != null) { ctx.startActivity(intent); ToolResult(true, "opened $pkg") }
        else ToolResult(false, "package $pkg not found")
    } catch (e: Exception) { ToolResult(false, e.message ?: "error") }
    private fun getLocation(): ToolResult {
        try {
            val prefs = ctx.getSharedPreferences("skytron", Context.MODE_PRIVATE)
            if (!prefs.getBoolean("gps_enabled", true)) return ToolResult(false, "GPS disabled in Settings")
            val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
            val gps = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER)
            val net = lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
            val loc = gps ?: net
            return if (loc != null) ToolResult(true, "lat=${loc.latitude}, lng=${loc.longitude}")
            else ToolResult(false, "location unavailable")
        } catch (e: Exception) { return ToolResult(false, e.message ?: "error") }
    }
    private fun takeScreenshot(): ToolResult = try {
        val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(intent)
        ToolResult(true, "opened accessibility settings")
    } catch (e: Exception) { ToolResult(false, e.message ?: "error") }
    private fun setReminder(input: String): ToolResult {
        try {
            val parts = input.split("|", limit = 2)
            if (parts.size < 2) return ToolResult(false, "Usage: text | minutes_from_now")
            val text = parts[0].trim()
            val mins = parts[1].trim().toLongOrNull() ?: return ToolResult(false, "invalid minutes")
            val triggerAt = System.currentTimeMillis() + mins * 60_000
            val db = AppDatabase.get(ctx)
            runBlocking(Dispatchers.IO) { db.reminderDao().insert(ReminderEntity(text = text, triggerAt = triggerAt)) }
            return ToolResult(true, "Reminder set for $mins minutes: $text")
        } catch (e: Exception) { return ToolResult(false, "reminder failed: ${e.message}") }
    }
    private fun getReminders(): ToolResult {
        try {
            val db = AppDatabase.get(ctx)
            val list = runBlocking(Dispatchers.IO) { db.reminderDao().pending() }
            if (list.isEmpty()) return ToolResult(true, "No pending reminders")
            val text = list.joinToString("\n") { "#${it.id}: ${it.text} (due ${formatTime(it.triggerAt)})" }
            return ToolResult(true, text)
        } catch (e: Exception) { return ToolResult(false, "error: ${e.message}") }
    }
    private fun formatTime(ts: Long): String {
        val df = java.text.SimpleDateFormat("MMM dd HH:mm", java.util.Locale.US)
        return df.format(java.util.Date(ts))
    }
    private fun setTimer(input: String): ToolResult = try {
        val intent = Intent(Intent.ACTION_INSERT).apply {
            data = Uri.parse("content://com.android.calendar/timers")
            putExtra("android.intent.extra.INTENT", input)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        ctx.startActivity(intent)
        ToolResult(true, "timer intent sent")
    } catch (e: Exception) { ToolResult(false, e.message ?: "error") }
}
