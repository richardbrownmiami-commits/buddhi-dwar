package com.skytron.platform
import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.material.bottomnavigation.BottomNavigationView
import com.skytron.platform.api.SkytronApi
import com.skytron.platform.R
data class CarouselPage(val title: String, val viewFactory: (LayoutInflater, ViewGroup) -> View)
class MainActivity : AppCompatActivity() {
    private lateinit var content: FrameLayout
    private lateinit var nav: BottomNavigationView
    private var currentPage: View? = null
    private fun getEnabledPerms(): Array<String> {
        val p = getSharedPreferences("skytron", MODE_PRIVATE)
        val list = mutableListOf<String>()
        if (p.getBoolean("mic_enabled", true)) list.add(Manifest.permission.RECORD_AUDIO)
        if (p.getBoolean("cam_enabled", true)) list.add(Manifest.permission.CAMERA)
        if (p.getBoolean("gps_enabled", true)) list.add(Manifest.permission.ACCESS_FINE_LOCATION)
        list.add(Manifest.permission.POST_NOTIFICATIONS)
        list.add(Manifest.permission.SYSTEM_ALERT_WINDOW)
        return list.toTypedArray()
    }
    private val permLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { startService() }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        content = findViewById(R.id.contentFrame)
        nav = findViewById(R.id.bottomNav)
        val prefs = getSharedPreferences("skytron", MODE_PRIVATE)
        val api = SkytronApi("", prefs.getString("api_key", "") ?: "")
        val brainUrl = { prefs.getString("brain_url", getString(R.string.brain_url_default)) ?: "" }
        val pages = listOf(
            CarouselPage("Chat") { inf, parent ->
                val v = inf.inflate(R.layout.fragment_chat, parent, false)
                v.findViewById<View>(R.id.micButton).setOnClickListener { startActivity(Intent(this, ChatActivity::class.java)) }
                v.findViewById<View>(R.id.messageInput).setOnClickListener { startActivity(Intent(this, ChatActivity::class.java)) }
                v
            },
            CarouselPage("Brain") { inf, parent ->
                val v = inf.inflate(R.layout.fragment_brain, parent, false)
                fun load() {
                    val phase = api.brainPhase(brainUrl())
                    val emotions = api.brainEmotions(brainUrl())
                    val stream = api.brainStream(brainUrl())
                    v.findViewById<TextView>(R.id.brainPhase).text = "Phase: ${phase?.get("phase") ?: "—"}"
                    val em = emotions?.let { e -> listOf("happy","energetic","intelligent","bad").joinToString("  ") { "$it=${e[it]}" } } ?: "—"
                    v.findViewById<TextView>(R.id.brainEmotions).text = "Emotions: $em"
                    v.findViewById<TextView>(R.id.brainEnergy).text = "Energy: ${emotions?.get("energy") ?: "—"}%  |  Confidence: ${emotions?.get("confidence") ?: "—"}%"
                    val thoughts = stream?.take(5)?.joinToString("\n") { m -> "${m["content"]?.toString()?.take(80) ?: ""}" } ?: "—"
                    v.findViewById<TextView>(R.id.brainThoughts).text = thoughts
                }
                v.findViewById<Button>(R.id.brainRefreshBtn).setOnClickListener { load() }
                v.postDelayed({ load() }, 500)
                v
            },
            CarouselPage("Avatar") { inf, parent ->
                val v = inf.inflate(R.layout.fragment_avatar_core, parent, false)
                v.setOnClickListener { startActivity(Intent(this, AvatarCoreActivity::class.java)) }
                v
            },
            CarouselPage("Vault") { inf, parent ->
                val v = inf.inflate(R.layout.fragment_vault, parent, false)
                v.setOnClickListener { startActivity(Intent(this, MediaGenerationActivity::class.java)) }
                v
            }
        )
        nav.setOnItemSelectedListener { item ->
            val idx = when (item.itemId) {
                R.id.nav_chat -> 0; R.id.nav_brain -> 1
                R.id.nav_avatar -> 2; R.id.nav_vault -> 3
                else -> 0
            }
            content.removeAllViews()
            currentPage = pages[idx].viewFactory(LayoutInflater.from(this), content)
            content.addView(currentPage)
            true
        }
        nav.selectedItemId = R.id.nav_chat
        requestPerms()
    }
    private fun requestPerms() {
        val needed = getEnabledPerms().filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (needed.isNotEmpty()) permLauncher.launch(needed.toTypedArray())
        else startService()
    }
    private fun startService() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            if (!pm.isIgnoringBatteryOptimizations(packageName)) {
                startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = android.net.Uri.parse("package:$packageName")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                })
            }
        }
        val intent = Intent(this, com.skytron.platform.service.AetherisForegroundService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent)
        else startService(intent)
    }
}