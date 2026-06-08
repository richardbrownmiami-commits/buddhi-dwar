package com.skytron.platform
import android.content.SharedPreferences
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.skytron.platform.api.ImageData
import com.skytron.platform.api.SkytronApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
class MediaGenerationActivity : AppCompatActivity() {
    private lateinit var api: SkytronApi
    private lateinit var prefs: SharedPreferences
    private val images = mutableListOf<ImageData>()
    private lateinit var adapter: ImageGridAdapter
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.fragment_vault)
        prefs = getSharedPreferences("skytron", MODE_PRIVATE)
        val key = prefs.getString("api_key", "") ?: ""
        val url = prefs.getString("gateway_url", getString(R.string.gateway_url)) ?: ""
        api = SkytronApi(url, key)
        val grid = findViewById<RecyclerView>(R.id.generationGrid)
        grid.layoutManager = GridLayoutManager(this, 2)
        adapter = ImageGridAdapter(images)
        grid.adapter = adapter
        val prompt = findViewById<EditText>(R.id.promptInput)
        val btn = findViewById<Button>(R.id.generateBtn)
        btn.setOnClickListener {
            val text = prompt.text.toString().trim()
            if (text.isEmpty()) { Toast.makeText(this, "Enter a prompt", Toast.LENGTH_SHORT).show(); return@setOnClickListener }
            btn.isEnabled = false; btn.text = "Generating..."
            lifecycleScope.launch {
                val resp = withContext(Dispatchers.IO) { api.generateImage(text) }
                btn.isEnabled = true; btn.text = "Generate"
                if (resp.error != null) {
                    Toast.makeText(this@MediaGenerationActivity, "Error: ${resp.error}", Toast.LENGTH_LONG).show()
                    return@launch
                }
                resp.data?.let { images.addAll(it); adapter.notifyDataSetChanged() }
                Toast.makeText(this@MediaGenerationActivity, "Done!", Toast.LENGTH_SHORT).show()
            }
        }
    }
}
