package com.skytron.platform.ui
import android.view.LayoutInflater
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.skytron.platform.ChatMessage
import com.skytron.platform.R
class ChatAdapter(private val items: MutableList<ChatMessage>) : RecyclerView.Adapter<ChatAdapter.Holder>() {
    override fun onCreateViewHolder(p: ViewGroup, t: Int) = Holder(
        LayoutInflater.from(p.context).inflate(R.layout.message_item, p, false)
    )
    override fun onBindViewHolder(h: Holder, i: Int) {
        val msg = items[i]
        h.text.text = msg.text
        h.text.setBackgroundResource(if (msg.isUser) R.drawable.msg_user else R.drawable.msg_bot)
        val lp = h.itemView.layoutParams as FrameLayout.LayoutParams
        lp.gravity = if (msg.isUser) Gravity.END else Gravity.START
        h.itemView.layoutParams = lp
    }
    override fun getItemCount() = items.size
    fun add(msg: ChatMessage) { items.add(msg); notifyItemInserted(items.size - 1) }
    class Holder(v: View) : RecyclerView.ViewHolder(v) {
        val text: TextView = v.findViewById(R.id.textMessage)
    }
}
