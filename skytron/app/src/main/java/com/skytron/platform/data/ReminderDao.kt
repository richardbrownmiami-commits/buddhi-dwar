package com.skytron.platform.data
import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query
@Dao
interface ReminderDao {
    @Insert suspend fun insert(r: ReminderEntity)
    @Query("SELECT * FROM reminders WHERE done = 0 AND triggerAt <= :now ORDER BY triggerAt ASC")
    suspend fun due(now: Long): List<ReminderEntity>
    @Query("SELECT * FROM reminders WHERE done = 0 ORDER BY triggerAt ASC LIMIT 50")
    suspend fun pending(): List<ReminderEntity>
    @Query("UPDATE reminders SET done = 1 WHERE id = :id")
    suspend fun markDone(id: Int)
}
