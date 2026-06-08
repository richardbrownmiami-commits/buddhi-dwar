package com.skytron.platform.upgrade
import android.content.Context
import android.util.Log
import com.google.gson.Gson
import com.skytron.platform.api.LlmMessage
import com.skytron.platform.api.SkytronApi
import dalvik.system.DexClassLoader
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.util.concurrent.TimeUnit
class SkillUpgrader(
    private val ctx: Context,
    private val api: SkytronApi,
    private val model: String,
    private val githubToken: String,
    private val githubRepo: String
) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()
    private val gson = Gson()
    private val jsonMt = "application/json".toMediaType()
    private val dexDir = File(ctx.filesDir, "dex").also { it.mkdirs() }
    private val loaded = mutableMapOf<String, Class<*>>()
    fun onUnknownTool(toolName: String, input: String): String {
        try {
            val code = generateCode(toolName, input) ?: return "Could not generate code for $toolName"
            Log.i("SkytronUpgrade", "Generated code for $toolName (${code.length} chars)")
            val runId = dispatchToGitHub(code) ?: return "Could not trigger GitHub build"
            Log.i("SkytronUpgrade", "Dispatched run $runId")
            Thread.sleep(30000)
            val dexBytes = pollArtifact(runId, 180_000) ?: return "Build did not complete in time"
            val dexFile = File(dexDir, "tool_$toolName.dex")
            dexFile.writeBytes(dexBytes)
            val loader = DexClassLoader(dexFile.absolutePath, dexDir.absolutePath, null, ctx.classLoader)
            val cls = loader.loadClass("com.skytron.patch.${toolName.replaceFirstChar { it.uppercase() }}Tool")
            loaded[toolName] = cls
            return "Skill '$toolName' compiled and injected. You can now use it."
        } catch (e: Exception) {
            Log.e("SkytronUpgrade", "upgrade failed", e)
            return "Upgrade failed: ${e.message}"
        }
    }
    private fun generateCode(tool: String, input: String): String? {
        val prompt = """Write a Kotlin class named ${tool.replaceFirstChar { it.uppercase() }}Tool in package com.skytron.patch.
It must have a companion object with a method: fun execute(input: String): String
The method should implement: $tool with input: $input
Use only Android SDK (no external libs). Return the plain result string.
Output ONLY the source code, no explanation."""
        val resp = api.callLlm(model, listOf(LlmMessage("system", "You are a Kotlin code generator for Android. Output only code."), LlmMessage("user", prompt)), temperature = 0.3, maxTokens = 1500)
        return resp.choices?.firstOrNull()?.message?.content?.let { extractCode(it) }
    }
    private fun dispatchToGitHub(code: String): Long? {
        try {
            val workflow = "dex-compiler.yml"
            val body = gson.toJson(mapOf("ref" to "main", "inputs" to mapOf("source" to code)))
            val req = Request.Builder()
                .url("https://api.github.com/repos/$githubRepo/actions/workflows/$workflow/dispatches")
                .header("Authorization", "Bearer $githubToken")
                .header("Accept", "application/vnd.github.v3+json")
                .post(body.toRequestBody(jsonMt)).build()
            val resp = http.newCall(req).execute()
            if (!resp.isSuccessful) { Log.w("SkytronUpgrade", "dispatch failed: ${resp.code}"); return null }
            resp.close()
            for (attempt in 0..20) {
                Thread.sleep(3000)
                val listUrl = "https://api.github.com/repos/$githubRepo/actions/workflows/$workflow/runs?per_page=1&status=queued"
                val rr = http.newCall(Request.Builder().url(listUrl).header("Authorization", "Bearer $githubToken").header("Accept", "application/vnd.github.v3+json").build()).execute()
                val runs = gson.fromJson(rr.body?.string(), Map::class.java)
                rr.close()
                val run = (runs?.get("workflow_runs") as? List<*>)?.firstOrNull() as? Map<*, *>
                if (run != null) return (run["id"] as? Number)?.toLong()
            }
            return null
        } catch (e: Exception) { Log.e("SkytronUpgrade", "dispatch error", e); return null }
    }
    private fun pollArtifact(runId: Long, timeoutMs: Long): ByteArray? {
        try {
            val deadline = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < deadline) {
                Thread.sleep(8000)
                val url = "https://api.github.com/repos/$githubRepo/actions/runs/$runId/artifacts"
                val rr = http.newCall(Request.Builder().url(url).header("Authorization", "Bearer $githubToken").header("Accept", "application/vnd.github.v3+json").build()).execute()
                val body = rr.body?.string() ?: continue
                rr.close()
                val data = gson.fromJson(body, Map::class.java)
                val artifacts = data["artifacts"] as? List<*>
                val art = artifacts?.firstOrNull() as? Map<*, *> ?: continue
                val dlUrl = art["archive_download_url"] as? String ?: continue
                val dlResp = http.newCall(Request.Builder().url(dlUrl).header("Authorization", "Bearer $githubToken").build()).execute()
                val zipBytes = dlResp.body?.bytes() ?: continue
                dlResp.close()
                val zipIn = java.util.zip.ZipInputStream(zipBytes.inputStream())
                var entry = zipIn.nextEntry
                while (entry != null) {
                    if (entry.name.endsWith(".dex")) return zipIn.readBytes()
                    entry = zipIn.nextEntry
                }
                zipIn.close()
            }
            return null
        } catch (e: Exception) { Log.e("SkytronUpgrade", "poll error", e); return null }
    }
    private fun extractCode(raw: String): String {
        val trimmed = raw.trim()
        val start = trimmed.indexOf("```kotlin").let { if (it >= 0) it + 10 else trimmed.indexOf("```").let { if (it >= 0) it + 4 else 0 } }
        val end = trimmed.indexOf("```", if (start > 0) start + 1 else 0).let { if (it >= start) it else trimmed.length }
        return trimmed.substring(start, end).trim()
    }
}