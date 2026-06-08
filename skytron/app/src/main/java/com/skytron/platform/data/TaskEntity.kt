package com.skytron.platform.data
import androidx.room.Entity
import androidx.room.PrimaryKey
@Entity(tableName = "tasks")
data class TaskEntity(
    @PrimaryKey(autoGenerate = true) val id: Int = 0,
    val type: String,
    val input: String,
    val status: String = "pending",
    val result: String? = null,
    val createdAt: Long = System.currentTimeMillis()
)
