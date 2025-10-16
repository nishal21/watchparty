#!/usr/bin/env node

import { query, testConnection } from './index.js';
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runMigration() {
  console.log('🚀 Starting database migration...');

  // Test connection first
  const connected = await testConnection();
  if (!connected) {
    console.error('❌ Cannot connect to database. Please check your NEON_DB_URL environment variable.');
    process.exit(1);
  }

  try {
    console.log('📋 Creating tables...');

    // Create rooms table
    await query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        anime VARCHAR(255) NOT NULL,
        episode VARCHAR(255) NOT NULL,
        host_id VARCHAR(255) NOT NULL,
        host_name VARCHAR(255) NOT NULL,
        settings JSONB DEFAULT '{"syncPlayback": true, "allowChat": true, "maxParticipants": 10}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        last_activity TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    // Create participants table
    await query(`
      CREATE TABLE IF NOT EXISTS participants (
        id VARCHAR(255) PRIMARY KEY,
        room_id VARCHAR(255) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        is_host BOOLEAN DEFAULT FALSE,
        joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    // Create messages table
    await query(`
      CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR(255) PRIMARY KEY,
        room_id VARCHAR(255) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        user_id VARCHAR(255) NOT NULL,
        user_name VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    // Create indexes for better performance
    await query(`
      CREATE INDEX IF NOT EXISTS idx_rooms_last_activity ON rooms(last_activity)
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_participants_room_id ON participants(room_id)
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id)
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)
    `);

    console.log('✅ Migration completed successfully!');
    console.log('📊 Created tables: rooms, participants, messages');
    console.log('🔍 Created indexes for optimal performance');

  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

// Run migration if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigration();
}

export { runMigration };