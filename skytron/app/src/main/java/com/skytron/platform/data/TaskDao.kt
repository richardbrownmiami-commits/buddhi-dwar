package com.skytron.platform.data
import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query
@Dao
interface TaskDao {
    @Insert suspend fun insert(task: TaskEntity)
    @Query("SELECT * FROM tasks ORDER BY createdAt DESC LIMIT 50") suspend fun recent(): List<TaskEntity>
    @Query("UPDATE tasks SET status = :status, result = :result WHERE id = :id") suspend fun update(id: Int, status: String, result: String?)
}
