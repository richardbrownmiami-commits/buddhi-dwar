package com.skytron.platform.service
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import java.util.Locale
class VoiceProcessor(ctx: Context) {
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private val prefs: SharedPreferences = ctx.getSharedPreferences("skytron", Context.MODE_PRIVATE)
    init {
        tts = TextToSpeech(ctx) { status ->
            if (status == TextToSpeech.SUCCESS) {
                tts?.let { t ->
                    val accent = prefs.getString("voice_accent", "US") ?: "US"
                    val loc = when (accent) {
                        "UK" -> Locale.UK; "AU" -> Locale("en", "AU")
                        "IN" -> Locale("en", "IN"); else -> Locale.US
                    }
                    t.language = loc
                    t.setPitch(prefs.getFloat("voice_pitch", 1.0f))
                    t.setSpeechRate(prefs.getFloat("voice_speed", 0.88f))
                    if (Build.VERSION.SDK_INT >= 21) {
                        val mode = prefs.getString("voice_quality", "neural") ?: "neural"
                        val match = when (mode) {
                            "neural_only" -> { v: Voice -> v.name.contains("neural", true) || v.name.contains("wavenet", true) }
                            "default" -> { _: Voice -> false }
                            else -> { v: Voice -> v.name.contains("neural", true) || v.name.contains("wavenet", true) || v.name.contains("highquality", true) }
                        }
                        val best = t.voices?.firstOrNull { v -> v.locale.language == "en" && match(v) }
                        if (best != null) t.voice = best
                    }
                    ttsReady = true
                }
            }
        }
    }
    fun speak(text: String, done: (() -> Unit)? = null) {
        if (!ttsReady) { done?.invoke(); return }
        tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onDone(uttId: String?) { done?.invoke() }
            override fun onError(uttId: String?) { done?.invoke() }
            override fun onStart(uttId: String?) {}
        })
        val bundle = if (Build.VERSION.SDK_INT >= 21) {
            android.os.Bundle().also { it.putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, "skytron_utt") }
        } else null
        tts?.speak(text, TextToSpeech.QUEUE_FLUSH, bundle, "skytron_utt")
    }
    fun shutdown() { tts?.stop(); tts?.shutdown() }
}
