// server.js
// Media Gallery + AI Studio backend.
//
// This server does two things:
//  1. Serves the static frontend (public/).
//  2. Exposes POST /api/generate-image which forwards a prompt (and an
//     optional source image) to Google's Gemini image model using the
//     API key the user supplies from the browser. The key is NEVER
//     stored on the server or committed to the repo — it is passed
//     per-request from the client and used only for that call.

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const PORT = process.env.PORT || 3000;
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

// Model that supports both text-to-image generation AND image editing
// (send an input image + instructions, get an edited image back).
const GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Store uploads in memory only — we forward the bytes to Google and
// never write them to disk on the server.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

/**
 * POST /api/generate-image
 * multipart/form-data fields:
 *   - apiKey   (required) the user's Google AI Studio API key
 *   - prompt   (required) text instructions
 *   - image    (optional) a source image file to edit
 *
 * Returns: { image: "data:image/png;base64,....", mimeType, text }
 */
app.post('/api/generate-image', upload.single('image'), async (req, res) => {
  try {
    const { apiKey, prompt } = req.body;

    if (!apiKey || !apiKey.trim()) {
      return res.status(400).json({ error: 'Missing Google AI Studio API key.' });
    }
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: 'Missing prompt.' });
    }

    const parts = [{ text: prompt.trim() }];

    if (req.file) {
      parts.push({
        inlineData: {
          mimeType: req.file.mimetype || 'image/png',
          data: req.file.buffer.toString('base64')
        }
      });
    }

    const url = `${GEMINI_API_BASE}/models/${GEMINI_IMAGE_MODEL}:generateContent`;

    const googleResp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey.trim()
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseModalities: ['IMAGE', 'TEXT']
        }
      })
    });

    const data = await googleResp.json();

    if (!googleResp.ok) {
      const message =
        (data && data.error && data.error.message) ||
        `Google API returned status ${googleResp.status}`;
      return res.status(googleResp.status).json({ error: message });
    }

    const candidate = data?.candidates?.[0];
    const responseParts = candidate?.content?.parts || [];

    let imageOut = null;
    let mimeType = 'image/png';
    let textOut = '';

    for (const part of responseParts) {
      if (part.inlineData && part.inlineData.data) {
        imageOut = part.inlineData.data;
        mimeType = part.inlineData.mimeType || mimeType;
      } else if (part.text) {
        textOut += part.text;
      }
    }

    if (!imageOut) {
      return res.status(502).json({
        error:
          textOut ||
          'The model did not return an image. Try rephrasing your prompt.'
      });
    }

    return res.json({
      image: `data:${mimeType};base64,${imageOut}`,
      mimeType,
      text: textOut
    });
  } catch (err) {
    console.error('Generate image error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Health check (useful for Render/Railway/Fly.io deploy checks)
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------
// WebRTC signaling (Socket.IO). This server never sees or relays
// the actual video/audio — it only exchanges the small handshake
// messages (offer/answer/ICE candidates) needed for two browsers
// to find each other. Once connected, media flows either directly
// P2P or through a TURN relay (see /api/turn-credentials below).
// ---------------------------------------------------------------
const roomOccupants = new Map(); // roomCode -> Set of socket ids

io.on('connection', (socket) => {
  socket.on('join-room', (roomCode) => {
    if (!roomCode) return;

    const existing = roomOccupants.get(roomCode) || new Set();
    if (existing.size >= 2) {
      socket.emit('room-full');
      return;
    }

    existing.add(socket.id);
    roomOccupants.set(roomCode, existing);
    socket.join(roomCode);
    socket.data.room = roomCode;

    const otherPeers = [...existing].filter(id => id !== socket.id);
    // Tell the newcomer who's already there (so it knows whether to
    // be the one to create the WebRTC "offer").
    socket.emit('joined-room', { initiator: otherPeers.length === 0, peers: otherPeers });
    // Tell existing peer(s) someone new arrived.
    socket.to(roomCode).emit('peer-joined', { peerId: socket.id });
  });

  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('leave-room', () => cleanupSocket(socket));
  socket.on('disconnect', () => cleanupSocket(socket));

  function cleanupSocket(sock) {
    const roomCode = sock.data.room;
    if (!roomCode) return;
    const set = roomOccupants.get(roomCode);
    if (set) {
      set.delete(sock.id);
      if (set.size === 0) roomOccupants.delete(roomCode);
    }
    sock.to(roomCode).emit('peer-left', { peerId: sock.id });
    sock.data.room = null;
  }
});

// ---------------------------------------------------------------
// TURN credentials endpoint. STUN alone (Google's public servers)
// works fine when both callers are on relatively open networks,
// but mobile carrier networks (e.g. Globe, Smart) commonly sit
// behind Carrier-Grade NAT that blocks direct P2P — that's the
// "black screen" scenario. A TURN server relays the media in that
// case. This defaults to the free public "Open Relay Project" demo
// TURN server so it works out of the box; for more reliable/higher
// -capacity TURN, sign up for a free Metered.ca account and set
// TURN_USERNAME / TURN_CREDENTIAL / TURN_URL as environment
// variables on Render (Dashboard → your service → Environment).
// ---------------------------------------------------------------
app.get('/api/turn-credentials', (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  } else {
    // Free public demo TURN server (Open Relay Project). Fine for
    // testing and light personal use; can hit capacity limits under
    // heavy use since it's a shared public resource.
    iceServers.push(
      { urls: 'turn:global.relay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:global.relay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:global.relay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
    );
  }

  res.json({ iceServers });
});

// Fallback to index.html for any other route (simple SPA-style serving)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

httpServer.listen(PORT, () => {
  console.log(`Media Gallery + AI Studio server running on port ${PORT}`);
});
