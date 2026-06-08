package com.skytron.platform.upgrade
import android.content.Context
import dalvik.system.DexClassLoader
import java.io.File
import java.net.URL
class DynamicCodeLoader(private val ctx: Context) {
    private val dexDir = File(ctx.filesDir, "dex").also { it.mkdirs() }
    private val loaded = mutableMapOf<String, Class<*>>()
    fun downloadAndLoad(dexUrl: String, className: String): Class<*>? {
        try {
            val dexFile = File(dexDir, "patch_${System.currentTimeMillis()}.dex")
            URL(dexUrl).openStream().use { input ->
                dexFile.outputStream().use { output -> input.copyTo(output) }
            }
            val loader = DexClassLoader(
                dexFile.absolutePath,
                dexDir.absolutePath,
                null,
                ctx.classLoader
            )
            val clazz = loader.loadClass(className)
            loaded[className] = clazz
            return clazz
        } catch (e: Exception) {
            android.util.Log.e("SkytronDex", "load failed", e)
            return null
        }
    }
    fun invokeMethod(className: String, methodName: String, vararg args: Any?): Any? {
        val clazz = loaded[className] ?: return null
        try {
            val methods = clazz.methods
            val method = methods.find { it.name == methodName } ?: return null
            val instance = if (method.declaringClass == clazz) clazz.getDeclaredConstructor().newInstance() else null
            return method.invoke(instance, *args)
        } catch (e: Exception) {
            android.util.Log.e("SkytronDex", "invoke failed", e)
            return null
        }
    }
}
