package com.skytron.platform.service
import android.content.Context
import android.graphics.Bitmap
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
data class VisionResult(val text: String? = null, val error: String? = null)
class VisionProcessor {
    private val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    suspend fun extractText(ctx: Context, bitmap: Bitmap): VisionResult {
        try {
            val image = InputImage.fromBitmap(bitmap, 0)
            val task = recognizer.process(image)
            val text = kotlinx.coroutines.suspendCancellableCoroutine<String> { cont ->
                task.addOnSuccessListener { cont.resumeWith(kotlin.Result.success(it.text)) }
                task.addOnFailureListener { cont.resumeWith(kotlin.Result.failure(it)) }
            }
            if (text.isBlank()) return VisionResult(error = "No text found")
            return VisionResult(text = text)
        } catch (e: Exception) { return VisionResult(error = e.message ?: "vision error") }
    }
}
