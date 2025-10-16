import pkg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pkg;

// PostgreSQL connection pool
let pool = null;

export function getPool() {
  if (!pool && process.env.NEON_DB_URL) {
    pool = new Pool({
      connectionString: process.env.NEON_DB_URL,
      ssl: {
        rejectUnauthorized: false // Required for Neon
      },
      max: 10, // Maximum number of clients in the pool
      idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
      connectionTimeoutMillis: 2000, // Return an error after 2 seconds if connection could not be established
    });

    // Handle pool errors
    pool.on('error', (err, client) => {
      console.error('❌ Unexpected error on idle client', err);
    });

    pool.on('connect', (client) => {
      console.log('🔌 Connected to PostgreSQL database');
    });

    pool.on('remove', (client) => {
      console.log('🔌 Client removed from pool');
    });
  }

  return pool;
}

export async function testConnection() {
  const pool = getPool();
  if (!pool) {
    console.log('⚠️  No database URL provided, using in-memory storage');
    return false;
  }

  try {
    const client = await pool.connect();
    console.log('✅ Database connection successful');
    client.release();
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    return false;
  }
}

export async function query(text, params) {
  const pool = getPool();
  if (!pool) {
    throw new Error('Database not configured');
  }

  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log('✅ Query executed in', duration, 'ms:', text);
    return res;
  } catch (error) {
    console.error('❌ Query failed:', text, error);
    throw error;
  }
}

export async function getClient() {
  const pool = getPool();
  if (!pool) {
    throw new Error('Database not configured');
  }

  return await pool.connect();
}

// Room operations
export async function saveRoom(room) {
  const pool = getPool();
  if (!pool) return null;

  try {
    const queryText = `
      INSERT INTO rooms (id, name, anime, episode, host_id, host_name, settings, created_at, last_activity)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        anime = EXCLUDED.anime,
        episode = EXCLUDED.episode,
        host_id = EXCLUDED.host_id,
        host_name = EXCLUDED.host_name,
        settings = EXCLUDED.settings,
        last_activity = EXCLUDED.last_activity
      RETURNING *
    `;

    const values = [
      room.id,
      room.name,
      room.anime,
      room.episode,
      room.host.id,
      room.host.name,
      JSON.stringify(room.settings),
      room.created,
      new Date(room.lastActivity).toISOString()
    ];

    const result = await query(queryText, values);
    return result.rows[0];
  } catch (error) {
    console.error('❌ Failed to save room:', error);
    return null;
  }
}

export async function getRoom(roomId) {
  const pool = getPool();
  if (!pool) return null;

  try {
    const queryText = `
      SELECT r.*, array_agg(p.*) as participants
      FROM rooms r
      LEFT JOIN participants p ON r.id = p.room_id
      WHERE r.id = $1
      GROUP BY r.id
    `;

    const result = await query(queryText, [roomId]);
    if (result.rows.length === 0) return null;

    const room = result.rows[0];
    return {
      ...room,
      settings: JSON.parse(room.settings),
      participants: room.participants.filter(p => p !== null)
    };
  } catch (error) {
    console.error('❌ Failed to get room:', error);
    return null;
  }
}

export async function deleteRoom(roomId) {
  const pool = getPool();
  if (!pool) return;

  try {
    // Delete participants first (cascade should handle this, but being explicit)
    await query('DELETE FROM participants WHERE room_id = $1', [roomId]);
    await query('DELETE FROM messages WHERE room_id = $1', [roomId]);
    await query('DELETE FROM rooms WHERE id = $1', [roomId]);
    console.log(`🗑️  Deleted room: ${roomId}`);
  } catch (error) {
    console.error('❌ Failed to delete room:', error);
  }
}

export async function saveParticipant(roomId, participant) {
  const pool = getPool();
  if (!pool) return null;

  try {
    const queryText = `
      INSERT INTO participants (id, room_id, name, is_host, joined_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        is_host = EXCLUDED.is_host
      RETURNING *
    `;

    const values = [
      participant.id,
      roomId,
      participant.name,
      participant.isHost,
      new Date(participant.joinedAt || Date.now()).toISOString()
    ];

    const result = await query(queryText, values);
    return result.rows[0];
  } catch (error) {
    console.error('❌ Failed to save participant:', error);
    return null;
  }
}

export async function removeParticipant(participantId) {
  const pool = getPool();
  if (!pool) return;

  try {
    await query('DELETE FROM participants WHERE id = $1', [participantId]);
  } catch (error) {
    console.error('❌ Failed to remove participant:', error);
  }
}

export async function saveMessage(roomId, message) {
  const pool = getPool();
  if (!pool) return null;

  try {
    const queryText = `
      INSERT INTO messages (id, room_id, user_id, user_name, content, timestamp)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;

    const values = [
      message.id,
      roomId,
      message.userId,
      message.userName,
      message.content,
      message.timestamp
    ];

    const result = await query(queryText, values);
    return result.rows[0];
  } catch (error) {
    console.error('❌ Failed to save message:', error);
    return null;
  }
}

export async function getRecentMessages(roomId, limit = 50) {
  const pool = getPool();
  if (!pool) return [];

  try {
    const queryText = `
      SELECT * FROM messages
      WHERE room_id = $1
      ORDER BY timestamp DESC
      LIMIT $2
    `;

    const result = await query(queryText, [roomId, limit]);
    return result.rows.reverse(); // Return in chronological order
  } catch (error) {
    console.error('❌ Failed to get messages:', error);
    return [];
  }
}

export async function cleanupInactiveRooms(timeoutMinutes = 30) {
  const pool = getPool();
  if (!pool) return;

  try {
    const cutoffTime = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();

    // Get rooms to delete
    const roomsToDelete = await query(
      'SELECT id FROM rooms WHERE last_activity < $1',
      [cutoffTime]
    );

    if (roomsToDelete.rows.length > 0) {
      const roomIds = roomsToDelete.rows.map(r => r.id);
      console.log(`🧹 Cleaning up ${roomIds.length} inactive rooms`);

      // Delete associated data
      for (const roomId of roomIds) {
        await deleteRoom(roomId);
      }
    }
  } catch (error) {
    console.error('❌ Failed to cleanup inactive rooms:', error);
  }
}