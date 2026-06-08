package com.skytron.platform.ui
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import com.skytron.platform.avatar.AvatarWebView
@SuppressLint("ViewConstructor")
class SystemAlertWidget(ctx: Context) : FrameLayout(ctx) {
    private val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private val avatar = AvatarWebView()
    private var params: WindowManager.LayoutParams
    private var initialX = 0f; private var initialY = 0f
    private var initialTouchX = 0f; private var initialTouchY = 0f
    private val handler = Handler(Looper.getMainLooper())
    private val speechBubble: TextView
    private var peekTimer: Runnable? = null
    private var attached = false
    init {
        val size = (160 * ctx.resources.displayMetrics.density).toInt()
        val bigSize = (220 * ctx.resources.displayMetrics.density).toInt()
        params = WindowManager.LayoutParams(
            size, size,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            android.graphics.PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 50; y = 200
        }
        val bigParams = WindowManager.LayoutParams(
            bigSize, bigSize,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            android.graphics.PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 30; y = 160
        }
        val wv = WebView(ctx).apply {
            layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
        }
        addView(wv)
        avatar.attach(wv)
        speechBubble = TextView(ctx).apply {
            text = ""
            textSize = 11f
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.argb(200, 10, 10, 30))
            setPadding(10, 6, 10, 6)
            layoutParams = LayoutParams(
                LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT
            ).apply { gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL; bottomMargin = 8 }
        }
        addView(speechBubble)
        setOnTouchListener { _, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    initialX = params.x.toFloat()
                    initialY = params.y.toFloat()
                    initialTouchX = event.rawX
                    initialTouchY = event.rawY
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    params.x = (initialX + (event.rawX - initialTouchX)).toInt()
                    params.y = (initialY + (event.rawY - initialTouchY)).toInt()
                    wm.updateViewLayout(this, params)
                    true
                }
                else -> false
            }
        }
    }
    fun peek(title: String, message: String) {
        val t = peekTimer
        if (t != null) handler.removeCallbacks(t)
        speechBubble.text = "$title: $message"
        avatar.setExpression("surprised")
        avatar.speakAnimation(message)
        show()
        val r = Runnable { avatar.setExpression("idle"); speechBubble.text = "" }
        peekTimer = r
        handler.postDelayed(r, 6000)
    }
    fun show() { if (!attached) { try { wm.addView(this, params); attached = true } catch (_: Exception) {} } }
    fun hide() { val t = peekTimer; if (t != null) handler.removeCallbacks(t); if (attached) { try { wm.removeView(this); attached = false } catch (_: Exception) {} } }
    fun destroy() { avatar.destroy(); hide() }
}
