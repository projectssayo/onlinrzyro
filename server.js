import express from "express";
import { MongoClient } from 'mongodb';
import crypto from 'crypto';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4555;

// MongoDB connection
const uri = 'mongodb+srv://projectssayo_db_user:1234@test.mdv08ad.mongodb.net/?retryWrites=true&w=majority&appName=test';
const client = new MongoClient(uri);
let db;

// Configuration
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_MESSAGE_LENGTH = 10000; // 10k chars for text
const ROOM_EXPIRY_MINUTES = 15;
const USER_EXPIRY_MINUTES = 30;

// Helper: generate random ID for users
function generateId(prefix = '', length = 8) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const randomBytes = crypto.randomBytes(length);
    let id = '';
    for (let i = 0; i < length; i++) {
        id += chars.charAt(randomBytes[i] % chars.length);
    }
    return prefix + id;
}

// Helper: generate clean uppercase alphanumeric room code (8 chars, no prefix)
function generateRoomCode(length = 8) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) {
        code += chars.charAt(bytes[i] % chars.length);
    }
    return code;
}

// Helper: validate message (text or image)
function validateMessage(message) {
    if (!message || typeof message !== 'string') {
        return { valid: false, error: 'Invalid message format' };
    }

    // Check if it's an image (base64)
    if (message.startsWith('data:image')) {
        // Extract MIME type correctly
        const mimeMatch = message.match(/^data:([^;]+);/);
        if (!mimeMatch) {
            return { valid: false, error: 'Invalid image data format' };
        }
        const format = mimeMatch[1]; // e.g., "image/jpeg"

        const base64Data = message.split(',')[1];
        if (!base64Data) {
            return { valid: false, error: 'Invalid image data' };
        }

        const imageSize = Buffer.from(base64Data, 'base64').length;
        if (imageSize > MAX_IMAGE_SIZE) {
            return { valid: false, error: `Image too large. Max ${MAX_IMAGE_SIZE / (1024 * 1024)}MB` };
        }

        // Validate image format
        const validFormats = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        if (!validFormats.includes(format)) {
            return { valid: false, error: 'Unsupported image format. Use JPEG, PNG, GIF, or WebP' };
        }

        return { valid: true, type: 'image', size: imageSize };
    } else {
        // Text message validation
        if (message.length > MAX_MESSAGE_LENGTH) {
            return { valid: false, error: `Message too long. Max ${MAX_MESSAGE_LENGTH} characters` };
        }
        return { valid: true, type: 'text', length: message.length };
    }
}

// Connect to MongoDB
async function connectDB() {
    try {
        await client.connect();
        db = client.db('anonymous_chat');
        console.log('✅ Connected to MongoDB');

        const users = db.collection('online_users');
        const rooms = db.collection('online_rooms');
        const messages = db.collection('online_messages');

        // Create TTL indexes
        await users.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
        await rooms.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
        await messages.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
        await messages.createIndex({ room_code: 1 });
        await messages.createIndex({ sent_at: -1 });
        await rooms.createIndex({ participants: 1 });

        console.log('✅ Database indexes created');
    } catch (err) {
        console.error('❌ MongoDB connection error:', err);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await client.close();
    process.exit(0);
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Increased limit for images
app.use(express.static(__dirname));

// Request logger middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// ------------------- User Endpoints -------------------
app.post('/register_user', async (req, res) => {
    try {
        const userId = generateId('user_', 12);
        const expiresAt = new Date(Date.now() + USER_EXPIRY_MINUTES * 60 * 1000);

        await db.collection('online_users').insertOne({
            _id: userId,
            created_at: new Date(),
            expires_at: expiresAt
        });

        res.json({
            success: true,
            user_id: userId,
            expires_at: expiresAt.toISOString()
        });
    } catch (err) {
        console.error('Register user error:', err);
        res.status(500).json({ error: 'Failed to register user' });
    }
});

app.post('/keep_alive', async (req, res) => {
    const { user_id } = req.body;
    if (!user_id) {
        return res.status(400).json({ error: 'user_id required' });
    }

    try {
        const newExpiry = new Date(Date.now() + USER_EXPIRY_MINUTES * 60 * 1000);
        const result = await db.collection('online_users').updateOne(
            { _id: user_id },
            { $set: { expires_at: newExpiry, last_seen: new Date() } }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({
            success: true,
            message: 'alive',
            expires_at: newExpiry.toISOString()
        });
    } catch (err) {
        console.error('Keep alive error:', err);
        res.status(500).json({ error: 'Failed to update user' });
    }
});

// ------------------- Room Endpoints -------------------
app.post('/create_room', async (req, res) => {
    const { created_by, max_participants = 100 } = req.body;
    if (!created_by) {
        return res.status(400).json({ error: 'created_by required' });
    }

    try {
        const user = await db.collection('online_users').findOne({ _id: created_by });
        if (!user) {
            return res.status(404).json({ error: 'User not found. Please register first.' });
        }

        // Generate a unique 8-character uppercase alphanumeric room code
        let roomCode;
        let existing;
        do {
            roomCode = generateRoomCode(8);
            existing = await db.collection('online_rooms').findOne({ _id: roomCode });
        } while (existing);

        const expiresAt = new Date(Date.now() + ROOM_EXPIRY_MINUTES * 60 * 1000);

        await db.collection('online_rooms').insertOne({
            _id: roomCode,
            created_by,
            participants: [created_by],
            created_at: new Date(),
            expires_at: expiresAt,
            max_participants,
            message_count: 0
        });

        res.json({
            success: true,
            room_code: roomCode,
            expires_at: expiresAt.toISOString(),
            participants: [created_by]
        });
    } catch (err) {
        console.error('Create room error:', err);
        res.status(500).json({ error: 'Failed to create room' });
    }
});

app.post('/join_room', async (req, res) => {
    const { room_code, user_id } = req.body;
    if (!room_code || !user_id) {
        return res.status(400).json({ error: 'room_code and user_id required' });
    }

    try {
        const user = await db.collection('online_users').findOne({ _id: user_id });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const room = await db.collection('online_rooms').findOne({ _id: room_code });
        if (!room) {
            return res.status(404).json({ error: 'Room not found' });
        }

        if (new Date() > room.expires_at) {
            return res.status(410).json({ error: 'Room expired' });
        }

        if (room.participants.includes(user_id)) {
            return res.json({
                success: true,
                message: 'Already in room',
                participants: room.participants
            });
        }

        if (room.participants.length >= room.max_participants) {
            return res.status(403).json({ error: 'Room is full' });
        }

        await db.collection('online_rooms').updateOne(
            { _id: room_code },
            { $addToSet: { participants: user_id } }
        );

        const updatedRoom = await db.collection('online_rooms').findOne({ _id: room_code });
        res.json({
            success: true,
            message: 'Joined',
            participants: updatedRoom.participants,
            expires_at: updatedRoom.expires_at.toISOString()
        });
    } catch (err) {
        console.error('Join room error:', err);
        res.status(500).json({ error: 'Failed to join room' });
    }
});

app.get('/room_info/:room_code', async (req, res) => {
    const { room_code } = req.params;
    try {
        const room = await db.collection('online_rooms').findOne({ _id: room_code });
        if (!room) {
            return res.status(404).json({ error: 'Room not found' });
        }

        res.json({
            success: true,
            room_code: room._id,
            created_by: room.created_by,
            participants: room.participants,
            created_at: room.created_at.toISOString(),
            expires_at: room.expires_at.toISOString(),
            max_participants: room.max_participants,
            message_count: room.message_count || 0
        });
    } catch (err) {
        console.error('Room info error:', err);
        res.status(500).json({ error: 'Failed to get room info' });
    }
});

app.post('/leave_room', async (req, res) => {
    const { room_code, user_id } = req.body;
    if (!room_code || !user_id) {
        return res.status(400).json({ error: 'Missing fields' });
    }

    try {
        const result = await db.collection('online_rooms').updateOne(
            { _id: room_code },
            { $pull: { participants: user_id } }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ error: 'Room not found' });
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Leave room error:', err);
        res.status(500).json({ error: 'Failed to leave room' });
    }
});

// ------------------- Message Endpoints -------------------
app.post('/send_message', async (req, res) => {
    const { room_code, from_id, message } = req.body;
    if (!room_code || !from_id || !message) {
        return res.status(400).json({ error: 'All fields required' });
    }

    // Validate message
    const validation = validateMessage(message);
    if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
    }

    try {
        const user = await db.collection('online_users').findOne({ _id: from_id });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const room = await db.collection('online_rooms').findOne({ _id: room_code });
        if (!room) {
            return res.status(404).json({ error: 'Room not found' });
        }

        if (new Date() > room.expires_at) {
            return res.status(410).json({ error: 'Room expired' });
        }

        if (!room.participants.includes(from_id)) {
            return res.status(403).json({ error: 'Not a participant in this room' });
        }

        const msgId = generateId('msg_', 12);
        const sentAt = new Date();

        // Truncate message if too long (should already be validated)
        const finalMessage = validation.type === 'image' ? message : message.trim().substring(0, MAX_MESSAGE_LENGTH);

        await db.collection('online_messages').insertOne({
            _id: msgId,
            room_code,
            from_id,
            message: finalMessage,
            message_type: validation.type,
            sent_at: sentAt,
            expires_at: room.expires_at,
            size: validation.type === 'image' ? validation.size : finalMessage.length
        });

        // Update room message count
        await db.collection('online_rooms').updateOne(
            { _id: room_code },
            { $inc: { message_count: 1 } }
        );

        res.json({
            success: true,
            status: 'sent',
            message_id: msgId,
            message_type: validation.type,
            sent_at: sentAt.toISOString()
        });
    } catch (err) {
        console.error('Send message error:', err);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// SSE endpoint for live messages
app.get('/stream_messages/:room_code', async (req, res) => {
    const { room_code } = req.params;
    const user_id = req.query.user_id;

    if (!user_id) {
        return res.status(400).json({ error: 'user_id required' });
    }

    // Set SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });

    // Send initial connection message
    res.write(`event: connected\ndata: ${JSON.stringify({ message: 'Connected to stream', room_code })}\n\n`);

    let changeStream = null;
    let pingInterval = null;

    try {
        const user = await db.collection('online_users').findOne({ _id: user_id });
        if (!user) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: 'User not found' })}\n\n`);
            return res.end();
        }

        const room = await db.collection('online_rooms').findOne({ _id: room_code });
        if (!room) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: 'Room not found' })}\n\n`);
            return res.end();
        }

        if (new Date() > room.expires_at) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: 'Room expired' })}\n\n`);
            return res.end();
        }

        if (!room.participants.includes(user_id)) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: 'Not a participant' })}\n\n`);
            return res.end();
        }

        // Set up change stream for new messages
        const pipeline = [
            {
                $match: {
                    operationType: 'insert',
                    'fullDocument.room_code': room_code,
                    'fullDocument.from_id': { $ne: user_id } // Don't send user's own messages back
                }
            }
        ];

        changeStream = db.collection('online_messages').watch(pipeline, {
            fullDocument: 'updateLookup'
        });

        changeStream.on('change', (change) => {
            const doc = change.fullDocument;
            if (doc) {
                const data = {
                    _id: doc._id,
                    room_code: doc.room_code,
                    from_id: doc.from_id,
                    message: doc.message,
                    message_type: doc.message_type || 'text',
                    sent_at: doc.sent_at.toISOString()
                };
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            }
        });

        changeStream.on('error', (err) => {
            console.error('Change stream error:', err);
            res.write(`event: error\ndata: ${JSON.stringify({ error: 'Stream error' })}\n\n`);
        });

        // Keep connection alive with ping
        pingInterval = setInterval(() => {
            res.write(`: ping ${Date.now()}\n\n`);
        }, 30000);

        // Handle client disconnect
        req.on('close', () => {
            console.log(`Client disconnected from room ${room_code}`);
            if (pingInterval) clearInterval(pingInterval);
            if (changeStream) changeStream.close();
        });

    } catch (err) {
        console.error('SSE error:', err);
        if (pingInterval) clearInterval(pingInterval);
        if (changeStream) changeStream?.close();

        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to establish stream' });
        } else {
            res.write(`event: error\ndata: ${JSON.stringify({ error: 'Stream error' })}\n\n`);
            res.end();
        }
    }
});

// Get message history for a room
app.get('/messages/:room_code', async (req, res) => {
    const { room_code } = req.params;
    const limit = parseInt(req.query.limit) || 100;
    const before = req.query.before; // For pagination

    try {
        let query = { room_code };
        if (before) {
            query.sent_at = { $lt: new Date(before) };
        }

        const messages = await db.collection('online_messages')
            .find(query)
            .sort({ sent_at: -1 })
            .limit(Math.min(limit, 200))
            .toArray();

        // Reverse to show oldest first
        messages.reverse();

        res.json({
            messages,
            count: messages.length,
            has_more: messages.length === limit
        });
    } catch (err) {
        console.error('Get messages error:', err);
        res.status(500).json({ error: 'Failed to get messages' });
    }
});

// Delete expired rooms and messages (cleanup endpoint - optional)
app.post('/cleanup', async (req, res) => {
    try {
        const now = new Date();
        const expiredRooms = await db.collection('online_rooms').deleteMany({ expires_at: { $lt: now } });
        const expiredMessages = await db.collection('online_messages').deleteMany({ expires_at: { $lt: now } });
        const expiredUsers = await db.collection('online_users').deleteMany({ expires_at: { $lt: now } });

        res.json({
            success: true,
            deleted: {
                rooms: expiredRooms.deletedCount,
                messages: expiredMessages.deletedCount,
                users: expiredUsers.deletedCount
            }
        });
    } catch (err) {
        console.error('Cleanup error:', err);
        res.status(500).json({ error: 'Cleanup failed' });
    }
});

// Serve index.html for root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 404 handler for undefined routes
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
        console.log(`📝 Features: Text messages + Images (max ${MAX_IMAGE_SIZE / (1024 * 1024)}MB)`);
        console.log(`⏱️  Room expiry: ${ROOM_EXPIRY_MINUTES} minutes`);
        console.log(`👤 User expiry: ${USER_EXPIRY_MINUTES} minutes`);
    });
}).catch(console.error);
