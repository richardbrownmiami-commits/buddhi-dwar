package com.skytron.platform.service
import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.SharedPreferences
import android.graphics.Path
import android.graphics.Rect
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
class AetherisAccessibilityService : AccessibilityService() {
    private val scope = CoroutineScope(Dispatchers.Main)
    private var lastScreenText = ""
    private var prefs: SharedPreferences? = null
    override fun onCreate() { super.onCreate(); prefs = getSharedPreferences("skytron", MODE_PRIVATE) }
    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (!isAllowed(event.packageName?.toString() ?: "")) return
        when (event.eventType) {
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
            AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED -> {
                scope.launch { captureScreen() }
            }
        }
    }
    private fun isAllowed(pkg: String): Boolean {
        val raw = prefs?.getString("allowed_apps", "") ?: ""
        if (raw.isBlank()) return false
        val allowed = raw.split(",").filter { it.isNotBlank() }.toSet()
        return pkg in allowed
    }
    private fun captureScreen() {
        val root = rootInActiveWindow ?: return
        val text = collectText(root)
        if (text.isNotBlank()) lastScreenText = text
        root.recycle()
    }
    private fun collectText(node: AccessibilityNodeInfo): String {
        val sb = StringBuilder()
        if (node.text != null) sb.appendLine(node.text)
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            sb.append(collectText(child))
            child.recycle()
        }
        return sb.toString()
    }
    fun getScreenText(): String = lastScreenText
    fun clickAt(x: Float, y: Float) {
        val path = Path().apply { moveTo(x, y); lineTo(x + 1, y + 1) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 100))
            .build()
        dispatchGesture(gesture, null, null)
    }
    fun findAndClick(text: String) {
        val root = rootInActiveWindow ?: return
        if (!isAllowed(root.packageName?.toString() ?: "")) { root.recycle(); return }
        val nodes = root.findAccessibilityNodeInfosByText(text)
        if (nodes.isNotEmpty()) {
            val node = nodes[0]
            val rect = Rect()
            node.getBoundsInScreen(rect)
            clickAt(rect.centerX().toFloat(), rect.centerY().toFloat())
            node.recycle()
        }
        root.recycle()
    }
    override fun onInterrupt() {}
}
