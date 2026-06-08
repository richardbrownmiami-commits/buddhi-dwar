package com.skytron.platform.data
import androidx.room.Entity
import androidx.room.PrimaryKey
@Entity(tableName = "reminders")
data class ReminderEntity(
    @PrimaryKey(autoGenerate = true) val id: Int = 0,
    val text: String,
    val triggerAt: Long,
    val done: Boolean = false,
    val createdAt: Long = System.currentTimeMillis()
)
