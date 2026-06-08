package com.skytron.platform
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.SeekBar
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat
import com.skytron.platform.service.AetherisForegroundService
class SettingsActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        val prefs = getSharedPreferences("skytron", MODE_PRIVATE)
        val apiKey = findViewById<EditText>(R.id.apiKeyInput)
        val gatewayUrl = findViewById<EditText>(R.id.gatewayUrlInput)
        val model = findViewById<EditText>(R.id.modelInput)
        val ghToken = findViewById<EditText>(R.id.githubTokenInput)
        val ghRepo = findViewById<EditText>(R.id.githubRepoInput)
        val brainUrl = findViewById<EditText>(R.id.brainUrlInput)
        val brainKey = findViewById<EditText>(R.id.brainKeyInput)
        apiKey.setText(prefs.getString("api_key", ""))
        gatewayUrl.setText(prefs.getString("gateway_url", getString(R.string.gateway_url)))
        model.setText(prefs.getString("model", "llama-3.3-70b-versatile"))
        ghToken.setText(prefs.getString("github_token", ""))
        ghRepo.setText(prefs.getString("github_repo", getString(R.string.github_repo_default)))
        brainUrl.setText(prefs.getString("brain_url", getString(R.string.brain_url_default)))
        brainKey.setText(prefs.getString("brain_key", ""))
        val micSwitch = findViewById<SwitchCompat>(R.id.micEnabledSwitch).apply {
            isChecked = prefs.getBoolean("mic_enabled", true)
        }
        val camSwitch = findViewById<SwitchCompat>(R.id.camEnabledSwitch).apply {
            isChecked = prefs.getBoolean("cam_enabled", true)
        }
        val gpsSwitch = findViewById<SwitchCompat>(R.id.gpsEnabledSwitch).apply {
            isChecked = prefs.getBoolean("gps_enabled", true)
        }
        val voiceQuality = findViewById<Spinner>(R.id.voiceQualitySpinner)
        val accentSp = findViewById<Spinner>(R.id.accentSpinner)
        val pitchSeek = findViewById<SeekBar>(R.id.pitchSeek)
        val speedSeek = findViewById<SeekBar>(R.id.speedSeek)
        val pitchLabel = findViewById<TextView>(R.id.pitchLabel)
        val speedLabel = findViewById<TextView>(R.id.speedLabel)
        ArrayAdapter.createFromResource(this, R.array.voice_quality, android.R.layout.simple_spinner_item).also {
            it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item); voiceQuality.adapter = it
        }
        ArrayAdapter.createFromResource(this, R.array.accents, android.R.layout.simple_spinner_item).also {
            it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item); accentSp.adapter = it
        }
        val sq = prefs.getString("voice_quality", "neural")
        voiceQuality.setSelection(when (sq) { "default" -> 0; "neural_only" -> 2; else -> 1 })
        val sa = prefs.getString("voice_accent", "US")
        val ac = resources.getStringArray(R.array.accents)
        accentSp.setSelection(ac.indexOfFirst { it.take(2) == sa }.coerceAtLeast(0))
        pitchSeek.progress = (prefs.getFloat("voice_pitch", 1.0f) * 10).toInt()
        speedSeek.progress = (prefs.getFloat("voice_speed", 0.88f) * 10).toInt()
        pitchLabel.text = "%.1fx".format(pitchSeek.progress / 10f)
        speedLabel.text = "%.1fx".format(speedSeek.progress / 10f)
        pitchSeek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(s: SeekBar?, v: Int, b: Boolean) { pitchLabel.text = "%.1fx".format(v / 10f) }
            override fun onStartTrackingTouch(s: SeekBar?) {}; override fun onStopTrackingTouch(s: SeekBar?) {}
        })
        speedSeek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(s: SeekBar?, v: Int, b: Boolean) { speedLabel.text = "%.1fx".format(v / 10f) }
            override fun onStartTrackingTouch(s: SeekBar?) {}; override fun onStopTrackingTouch(s: SeekBar?) {}
        })
        findViewById<Button>(R.id.manageAppsBtn).setOnClickListener {
            startActivity(Intent(this, AppWhitelistActivity::class.java))
        }
        findViewById<Button>(R.id.saveBtn).setOnClickListener {
            val quality = when (voiceQuality.selectedItemPosition) { 0 -> "default"; 2 -> "neural_only"; else -> "neural" }
            val accent = (accentSp.selectedItem as String).take(2)
            prefs.edit().apply {
                putString("api_key", apiKey.text.toString().trim())
                putString("gateway_url", gatewayUrl.text.toString().trim())
                putString("model", model.text.toString().trim())
                putString("github_token", ghToken.text.toString().trim())
                putString("github_repo", ghRepo.text.toString().trim())
                putString("brain_url", brainUrl.text.toString().trim())
                putString("brain_key", brainKey.text.toString().trim())
                putBoolean("mic_enabled", micSwitch.isChecked)
                putBoolean("cam_enabled", camSwitch.isChecked)
                putBoolean("gps_enabled", gpsSwitch.isChecked)
                putString("voice_quality", quality); putString("voice_accent", accent)
                putFloat("voice_pitch", pitchSeek.progress / 10f); putFloat("voice_speed", speedSeek.progress / 10f)
                apply()
            }
            val intent = Intent(this, AetherisForegroundService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent) else startService(intent)
            Toast.makeText(this, "Saved & service started", Toast.LENGTH_SHORT).show()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
                startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION).apply {
                    data = android.net.Uri.parse("package:$packageName") })
            }
        }
        findViewById<Button>(R.id.stopServiceBtn).setOnClickListener {
            stopService(Intent(this, AetherisForegroundService::class.java))
            Toast.makeText(this, "Service stopped", Toast.LENGTH_SHORT).show()
        }
    }
}
