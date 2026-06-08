package com.skytron.platform
import android.content.SharedPreferences
import android.os.Bundle
import android.speech.SpeechRecognizer
import android.widget.EditText
import android.widget.ImageButton
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.Toolbar
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.skytron.platform.api.LlmMessage
import com.skytron.platform.api.SkytronApi
import com.skytron.platform.upgrade.SkillUpgrader
import com.skytron.platform.data.AppDatabase
import com.skytron.platform.data.MessageEntity
import com.skytron.platform.engine.ReActEngine
import com.skytron.platform.ui.ChatAdapter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
data class ChatMessage(val text: String, val isUser: Boolean)
class ChatActivity : AppCompatActivity() {
    private lateinit var api: SkytronApi
    private lateinit var engine: ReActEngine
    private lateinit var db: AppDatabase
    private lateinit var adapter: ChatAdapter
    private lateinit var prefs: SharedPreferences
    private var recognizer: SpeechRecognizer? = null
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_chat)
        val toolbar = findViewById<Toolbar>(R.id.toolbar)
        toolbar.setNavigationIcon(android.R.drawable.ic_menu_close_clear_cancel)
        toolbar.setNavigationOnClickListener { finish() }
        prefs = getSharedPreferences("skytron", MODE_PRIVATE)
        db = AppDatabase.get(this)
        val key = prefs.getString("api_key", "") ?: ""
        val url = prefs.getString("gateway_url", getString(R.string.gateway_url)) ?: ""
        val model = prefs.getString("model", "llama-3.3-70b-versatile") ?: ""
        val sys = prefs.getString("system_prompt", "")?.ifBlank {
            try { assets.open("system_prompt.txt").bufferedReader().readText() } catch (_: Exception) { getString(R.string.system_prompt) }
        } ?: ""
        api = SkytronApi(url, key)
        val ghToken = prefs.getString("github_token", "") ?: ""
        val ghRepo = prefs.getString("github_repo", "richardbrownmiami-commits/skytron-platform") ?: ""
        val upgrader = if (ghToken.isNotBlank()) SkillUpgrader(this, api, model, ghToken, ghRepo) else null
        engine = ReActEngine(this, api, model, sys, upgrader)
        val rv = findViewById<RecyclerView>(R.id.chatRecycler)
        adapter = ChatAdapter(mutableListOf())
        rv.adapter = adapter
        rv.layoutManager = LinearLayoutManager(this)
        val input = findViewById<EditText>(R.id.messageInput)
        val send = findViewById<ImageButton>(R.id.sendBtn)
        send.setOnClickListener {
            val text = input.text.toString().trim()
            if (text.isEmpty()) return@setOnClickListener
            input.text.clear()
            lifecycleScope.launch {
                adapter.add(ChatMessage(text, true))
                db.messageDao().insert(MessageEntity(role = "user", content = text))
                val history = mutableListOf(LlmMessage("system", sys))
                val result = withContext(Dispatchers.IO) { engine.process(text, history) }
                adapter.add(ChatMessage(result.content, false))
                db.messageDao().insert(MessageEntity(role = "assistant", content = result.content))
            }
        }
    }
    override fun onDestroy() {
        recognizer?.destroy()
        super.onDestroy()
    }
}
