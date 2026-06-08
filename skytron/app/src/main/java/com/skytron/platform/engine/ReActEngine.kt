package com.skytron.platform.engine
import android.content.Context
import com.skytron.platform.api.LlmMessage
import com.skytron.platform.api.SkytronApi
data class ReActStep(val thought: String, val action: String?, val observation: String?, val response: String?)
class ReActEngine(
    private val ctx: Context,
    private val api: SkytronApi,
    private val model: String,
    private val systemPrompt: String,
    private val upgrader: com.skytron.platform.upgrade.SkillUpgrader? = null
) {
    private val toolExec = ToolExecutor(ctx)
    private val maxLoop = 5
    fun process(userInput: String, history: MutableList<LlmMessage>): LlmMessage {
        history.add(LlmMessage("user", userInput))
        var finalResponse = ""
        for (i in 0 until maxLoop) {
            val resp = api.callLlm(model, listOf(LlmMessage("system", systemPrompt)) + history)
            val content = resp.choices?.firstOrNull()?.message?.content ?: return LlmMessage("assistant", "LLM error: ${resp.error}")
            history.add(LlmMessage("assistant", content))
            val toolMatch = Regex("""TOOL:(\w+):(.+?)(?:\n|$)""", RegexOption.DOT_MATCHES_ALL).find(content)
            if (toolMatch == null) {
                finalResponse = content; break
            }
            val tool = toolMatch.groupValues[1]
            val input = toolMatch.groupValues[2].trim()
            var result = toolExec.execute(tool, input)
            if (!result.success && result.output.startsWith("Unknown tool:") && upgrader != null) {
                val upgradeMsg = upgrader.onUnknownTool(tool, input)
                result = toolExec.execute(tool, input)
                if (!result.success) result = ToolResult(false, "$upgradeMsg (but still failed: ${result.output})")
            }
            history.add(LlmMessage("system", "OBSERVATION: ${result.output}"))
            if (i == maxLoop - 1) finalResponse = "Completed after $maxLoop steps."
        }
        return LlmMessage("assistant", finalResponse.ifBlank { "Done." })
    }
}
