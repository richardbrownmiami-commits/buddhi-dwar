package com.skytron.platform.ui
import android.animation.Animator
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.view.View
import android.view.animation.AccelerateDecelerateInterpolator
class RippleOverlay(context: Context) : View(context) {
    private val ripples = mutableListOf<Ripple>()
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    fun burst(cx: Float, cy: Float) {
        val r = Ripple(cx, cy)
        ripples.add(r)
        ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 1200
            interpolator = AccelerateDecelerateInterpolator()
            addUpdateListener { anim ->
                r.progress = anim.animatedFraction
                invalidate()
            }
            addListener(object : Animator.AnimatorListener {
                override fun onAnimationStart(a: Animator) {}
                override fun onAnimationEnd(a: Animator) { ripples.remove(r) }
                override fun onAnimationCancel(a: Animator) { ripples.remove(r) }
                override fun onAnimationRepeat(a: Animator) {}
            })
            start()
        }
    }
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        for (r in ripples) {
            val radius = r.progress * maxOf(width, height) * 1.5f
            val alpha = ((1 - r.progress) * 120).toInt()
            paint.shader = RadialGradient(
                r.cx, r.cy, radius,
                intArrayOf(0x22FFFFFF and (alpha shl 24), 0x00FFFFFF),
                floatArrayOf(0.3f, 1f),
                Shader.TileMode.CLAMP
            )
            canvas.drawCircle(r.cx, r.cy, radius, paint)
        }
    }
    private data class Ripple(val cx: Float, val cy: Float, var progress: Float = 0f)
}