# Otazumi Watch Party Server

Real-time watch party server for synchronized anime watching with chat functionality.

## Features

- **Real-time Communication**: WebSocket-based communication using Socket.io
- **Room Management**: Create and join watch party rooms
- **Playback Synchronization**: Sync video playback across all participants
- **Chat System**: Real-time messaging between participants
- **Host Controls**: Room hosts can kick participants and transfer host privileges
- **Auto Cleanup**: Inactive rooms are automatically cleaned up after 30 minutes

## API Endpoints

### HTTP Endpoints

- `GET /` - API documentation and server status
- `GET /health` - Health check endpoint
- `GET /api/rooms` - Get active rooms (development only)
- `POST /api/rooms` - Create a new room

### WebSocket Events

#### Client → Server
- `join-room` - Join a watch party room
- `leave-room` - Leave current room
- `send-message` - Send chat message
- `update-playback` - Update playback state (host only)
- `kick-participant` - Kick a participant (host only)
- `transfer-host` - Transfer host privileges (host only)

#### Server → Client
- `room-joined` - Successfully joined room with room data
- `participant-joined` - New participant joined
- `participant-left` - Participant left room
- `participant-kicked` - Participant was kicked
- `host-changed` - Host was transferred
- `new-message` - New chat message received
- `playback-updated` - Playback state updated
- `kicked` - User was kicked from room
- `error` - Error occurred

## Environment Variables

- `PORT` - Server port (default: 3002)
- `NODE_ENV` - Environment (production/development)
- `ALLOWED_ORIGINS` - Comma-separated list of allowed CORS origins

## Deployment to Vercel

1. **Install Vercel CLI** (if not already installed):
   ```bash
   npm install -g vercel
   ```

2. **Deploy to Vercel**:
   ```bash
   cd watch-party-server
   vercel --prod
   ```

3. **Set Environment Variables** in Vercel dashboard:
   - `NODE_ENV`: `production`
   - `ALLOWED_ORIGINS`: `https://otazumi.netlify.app,https://otazumi.page,https://www.otazumi.page`

## Local Development

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Start development server**:
   ```bash
   npm run dev
   ```

3. **Start production server**:
   ```bash
   npm start
   ```

## Room Data Structure

```javascript
{
  id: "room-uuid",
  name: "Watch Party Name",
  anime: "Anime Title",
  episode: "Episode Number",
  host: {
    id: "user-uuid",
    name: "Host Name"
  },
  participants: Map([
    ["socket-id", {
      id: "socket-id",
      name: "User Name",
      isHost: true/false,
      joinedAt: timestamp
    }]
  ]),
  messages: [
    {
      id: "message-uuid",
      userId: "socket-id",
      userName: "User Name",
      content: "Message content",
      timestamp: "ISO string"
    }
  ],
  playbackState: {
    isPlaying: true/false,
    currentTime: 0,
    duration: 0,
    lastUpdated: timestamp
  },
  settings: {
    syncPlayback: true,
    allowChat: true,
    maxParticipants: 10
  },
  created: "ISO string",
  lastActivity: timestamp
}
```

## Security Features

- CORS protection with configurable allowed origins
- Helmet.js security headers
- Rate limiting (inherited from email server patterns)
- Input validation for all API endpoints
- Automatic cleanup of inactive rooms

## Limitations

- In-memory storage (rooms are lost on server restart)
- No persistent message history
- Room timeout after 30 minutes of inactivity
- Maximum 10 participants per room (configurable)

## Future Enhancements

- PostgreSQL persistence for rooms and messages
- User authentication and authorization
- Room password protection
- File upload for custom room avatars
- Voice chat integration
- Screen sharing capabilities