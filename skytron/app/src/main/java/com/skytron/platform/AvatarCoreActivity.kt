package com.skytron.platform
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import com.skytron.platform.avatar.AvatarWebView
import com.skytron.platform.ui.RippleOverlay
class AvatarCoreActivity : AppCompatActivity() {
    private lateinit var avatar: AvatarWebView
    private lateinit var ripple: RippleOverlay
    private var pollHandler: Handler? = null
    private val pollInterval = 10000L
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.fragment_avatar_core)
        val wv = findViewById<WebView>(R.id.avatarWebView)
        avatar = AvatarWebView()
        avatar.attach(wv, "https://cdn.jsdelivr.net/gh/guansss/pixi-live2d-display@0.4.0/test/assets/haru/haru_greeter_t03.model3.json")
        ripple = RippleOverlay(this).apply {
            id = android.R.id.background
            layoutParams = android.view.ViewGroup.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.MATCH_PARENT
            )
        }
        (findViewById<android.widget.FrameLayout>(android.R.id.content)).addView(ripple)
        window.decorView.postDelayed({
            avatar.setExpression("happy")
        }, 2000)
        pollBrainMood()
    }
    private fun pollBrainMood() {
        val prefs = getSharedPreferences("skytron", MODE_PRIVATE)
        val brainUrl = prefs.getString("brain_url", getString(R.string.brain_url_default)) ?: ""
        val apiKey = prefs.getString("api_key", "") ?: ""
        val api = com.skytron.platform.api.SkytronApi("", apiKey)
        pollHandler = Handler(Looper.getMainLooper())
        pollHandler?.post(object : Runnable {
            override fun run() {
                try {
                    val phase = api.brainPhase(brainUrl)
                    val mood = phase?.get("phase") as? String ?: ""
                    avatar.setExpression(when {
                        mood == "curious" -> "surprise"
                        mood == "tired" -> "sad"
                        mood == "sleeping" -> "sad"
                        else -> "happy"
                    })
                } catch (_: Exception) {}
                pollHandler?.postDelayed(this, pollInterval)
            }
        })
    }
    override fun onDestroy() {
        pollHandler?.removeCallbacksAndMessages(null)
        avatar.destroy()
        super.onDestroy()
    }
}
