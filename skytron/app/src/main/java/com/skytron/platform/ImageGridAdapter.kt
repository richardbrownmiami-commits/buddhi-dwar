package com.skytron.platform
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import androidx.recyclerview.widget.RecyclerView
import com.bumptech.glide.Glide
import com.skytron.platform.api.ImageData
class ImageGridAdapter(private val items: List<ImageData>) : RecyclerView.Adapter<ImageGridAdapter.Holder>() {
    override fun onCreateViewHolder(p: ViewGroup, t: Int) = Holder(
        ImageView(p.context).apply {
            layoutParams = ViewGroup.LayoutParams(200, 200)
            scaleType = ImageView.ScaleType.CENTER_CROP
        }
    )
    override fun onBindViewHolder(h: Holder, i: Int) {
        val item = items[i]
        val url = item.url ?: item.b64_json?.let { "data:image/png;base64,$it" }
        if (url != null) {
            Glide.with(h.image.context).load(url).centerCrop().into(h.image)
        }
    }
    override fun getItemCount() = items.size
    class Holder(val image: ImageView) : RecyclerView.ViewHolder(image)
}
