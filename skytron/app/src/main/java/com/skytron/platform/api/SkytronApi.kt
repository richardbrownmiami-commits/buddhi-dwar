package com.skytron.platform.api
import com.google.gson.Gson
import com.google.gson.annotations.SerializedName
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit
data class LlmMessage(val role: String, val content: String)
data class LlmRequest(
    val model: String,
    val messages: List<LlmMessage>,
    val temperature: Double = 0.7,
    @SerializedName("max_tokens") val maxTokens: Int = 512
)
data class LlmChoice(
    val message: LlmMessage?,
    val index: Int = 0,
    @SerializedName("finish_reason") val finishReason: String? = null
)
data class LlmUsage(
    @SerializedName("prompt_tokens") val promptTokens: Int = 0,
    @SerializedName("completion_tokens") val completionTokens: Int = 0,
    @SerializedName("total_tokens") val totalTokens: Int = 0
)
data class LlmResponse(
    val choices: List<LlmChoice>? = null,
    val usage: LlmUsage? = null,
    val model: String? = null,
    val error: String? = null
)
data class ImageGenRequest(
    val model: String = "flux",
    val prompt: String,
    val n: Int = 1
)
data class ImageGenResponse(
    val data: List<ImageData>? = null,
    val error: String? = null
)
data class ImageData(val url: String? = null, val b64_json: String? = null)
class SkytronApi(private val gatewayUrl: String, private val apiKey: String) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()
    private val gson = Gson()
    private val jsonMt = "application/json".toMediaType()
    fun callLlm(model: String, messages: List<LlmMessage>, temperature: Double = 0.7, maxTokens: Int = 512): LlmResponse {
        val req = LlmRequest(model, messages, temperature, maxTokens)
        val json = gson.toJson(req)
        val body = json.toRequestBody(jsonMt)
        val request = Request.Builder()
            .url("$gatewayUrl/v1/chat/completions")
            .header("Authorization", "Bearer $apiKey")
            .header("Content-Type", "application/json")
            .post(body)
            .build()
        return try {
            val resp = client.newCall(request).execute()
            val respBody = resp.body?.string() ?: return LlmResponse(error = "empty body")
            if (!resp.isSuccessful) return LlmResponse(error = "HTTP ${resp.code}: $respBody")
            gson.fromJson(respBody, LlmResponse::class.java)
        } catch (e: Exception) {
            LlmResponse(error = e.message ?: "unknown error")
        }
    }
    // ── Brain endpoints ──
    fun brainPhase(brainUrl: String): Map<String, Any>? = try {
        val r = client.newCall(Request.Builder().url("$brainUrl/brain/phase").get().build()).execute()
        if (r.isSuccessful) @Suppress("UNCHECKED_CAST") gson.fromJson(r.body?.string(), Map::class.java) as Map<String, Any>? else null
    } catch (_: Exception) { null }
    fun brainEmotions(brainUrl: String): Map<String, Any>? = try {
        val r = client.newCall(Request.Builder().url("$brainUrl/brain/emotions").get().build()).execute()
        if (r.isSuccessful) @Suppress("UNCHECKED_CAST") gson.fromJson(r.body?.string(), Map::class.java) as Map<String, Any>? else null
    } catch (_: Exception) { null }
    fun brainActivity(brainUrl: String): List<Map<String, Any>>? = try {
        val r = client.newCall(Request.Builder().url("$brainUrl/brain/activity").get().build()).execute()
        if (r.isSuccessful) @Suppress("UNCHECKED_CAST") gson.fromJson(r.body?.string(), List::class.java) as List<Map<String, Any>>? else null
    } catch (_: Exception) { null }
    fun brainStream(brainUrl: String): List<Map<String, Any>>? = try {
        val r = client.newCall(Request.Builder().url("$brainUrl/brain/stream").get().build()).execute()
        if (r.isSuccessful) @Suppress("UNCHECKED_CAST") gson.fromJson(r.body?.string(), List::class.java) as List<Map<String, Any>>? else null
    } catch (_: Exception) { null }
    fun brainThink(brainUrl: String, input: String, key: String = ""): Map<String, Any>? = try {
        val body = gson.toJson(mapOf("input" to input)).toRequestBody(jsonMt)
        val req = Request.Builder().url("$brainUrl/think").post(body)
        if (key.isNotBlank()) req.header("Authorization", "Bearer $key")
        val r = client.newCall(req.build()).execute()
        if (r.isSuccessful) @Suppress("UNCHECKED_CAST") gson.fromJson(r.body?.string(), Map::class.java) as Map<String, Any>? else null
    } catch (_: Exception) { null }
    fun generateImage(prompt: String): ImageGenResponse {
        val req = ImageGenRequest(prompt = prompt)
        val json = gson.toJson(req)
        val body = json.toRequestBody(jsonMt)
        val request = Request.Builder()
            .url("$gatewayUrl/v1/images/generations")
            .header("Authorization", "Bearer $apiKey")
            .header("Content-Type", "application/json")
            .post(body)
            .build()
        return try {
            val resp = client.newCall(request).execute()
            val respBody = resp.body?.string() ?: return ImageGenResponse(error = "empty body")
            if (!resp.isSuccessful) return ImageGenResponse(error = "HTTP ${resp.code}: $respBody")
            gson.fromJson(respBody, ImageGenResponse::class.java)
        } catch (e: Exception) {
            ImageGenResponse(error = e.message ?: "unknown error")
        }
    }
}
