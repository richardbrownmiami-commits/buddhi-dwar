package com.skytron.platform.data
import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query
@Dao
interface MessageDao {
    @Insert suspend fun insert(msg: MessageEntity)
    @Query("SELECT * FROM messages ORDER BY timestamp ASC") suspend fun getAll(): List<MessageEntity>
    @Query("DELETE FROM messages") suspend fun clear()
}
