package com.skytron.platform.avatar
import android.annotation.SuppressLint
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
class AvatarWebView {
    private var webView: WebView? = null
    private var initialized = false
    @SuppressLint("SetJavaScriptEnabled")
    fun attach(wv: WebView, modelUrl: String = "https://cdn.jsdelivr.net/gh/guansss/pixi-live2d-display@0.4.0/test/assets/haru/haru_greeter_t03.model3.json") {
        webView = wv
        wv.settings.javaScriptEnabled = true
        wv.settings.allowFileAccess = true
        wv.settings.domStorageEnabled = true
        wv.addJavascriptInterface(BridgeInterface(), "SkytronBridge")
        wv.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                initialized = true
                wv.evaluateJavascript("init('$modelUrl')", null)
            }
        }
        wv.loadUrl("file:///android_asset/avatar.html")
    }
    fun setExpression(expr: String) {
        if (!initialized) return
        webView?.evaluateJavascript("setExpression('$expr')", null)
    }
    fun showRipple(x: Float? = null, y: Float? = null) {
        if (!initialized) return
        webView?.evaluateJavascript("triggerRipple(${x ?: "null"}, ${y ?: "null"})", null)
    }
    fun speakAnimation(text: String) {
        if (!initialized) return
        webView?.evaluateJavascript("speak('${text.replace("'", "\\'")}')", null)
    }
    fun destroy() { webView?.destroy(); webView = null }
    private class BridgeInterface {
        @JavascriptInterface fun onAvatarReady() {}
    }
}
