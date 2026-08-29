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
// (send an input image + instructions, get an edited image back), used
// as the default when the person picks Google or OpenRouter without
// specifying their own model.
const GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const OPENROUTER_DEFAULT_IMAGE_MODEL = 'google/gemini-2.5-flash-image';

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
 *   - provider (required) one of: "google" | "openrouter" | "groq" | "custom"
 *   - apiKey   (required) the API key for that provider
 *   - prompt   (required) text instructions
 *   - model    (optional) override the default model for that provider
 *   - baseUrl  (required only for provider "custom") an OpenAI-compatible base URL
 *   - image    (optional) a source image file to edit / analyze
 *
 * Returns: { image: "data:...;base64,....", text } — image is omitted
 * when the provider/model only supports analyzing images, not creating them.
 */
app.post('/api/generate-image', upload.single('image'), async (req, res) => {
  try {
    const { apiKey, prompt, provider, model, baseUrl } = req.body;

    if (!apiKey || !apiKey.trim()) {
      return res.status(400).json({ error: 'Missing API key.' });
    }
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: 'Missing prompt.' });
    }

    const imageFile = req.file
      ? { buffer: req.file.buffer, mimeType: req.file.mimetype || 'image/png' }
      : null;

    let result;
    switch (provider) {
      case 'google':
        result = await callGoogleGemini({ apiKey, prompt, imageFile });
        break;
      case 'openrouter':
        result = await callOpenRouterImages({ apiKey, prompt, imageFile, model });
        break;
      case 'groq':
        result = await callOpenAICompatibleVision({
          apiKey,
          prompt,
          imageFile,
          model,
          baseUrl: 'https://api.groq.com/openai/v1',
          providerLabel: 'Groq'
        });
        break;
      case 'custom':
        if (!baseUrl || !baseUrl.trim()) {
          return res.status(400).json({ error: 'Missing Base URL for the custom provider.' });
        }
        result = await callOpenAICompatibleVision({
          apiKey,
          prompt,
          imageFile,
          model,
          baseUrl: baseUrl.trim().replace(/\/+$/, ''),
          providerLabel: 'Custom provider'
        });
        break;
      default:
        return res.status(400).json({ error: 'Unknown or missing provider.' });
    }

    return res.json(result);
  } catch (err) {
    console.error('Generate image error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ---- Provider: Google AI Studio (Gemini) — image generation + editing ----
async function callGoogleGemini({ apiKey, prompt, imageFile }) {
  const parts = [{ text: prompt.trim() }];
  if (imageFile) {
    parts.push({
      inlineData: { mimeType: imageFile.mimeType, data: imageFile.buffer.toString('base64') }
    });
  }

  const url = `${GEMINI_API_BASE}/models/${GEMINI_IMAGE_MODEL}:generateContent`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey.trim() },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
    })
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error((data && data.error && data.error.message) || `Google API returned status ${resp.status}`);
  }

  const responseParts = data?.candidates?.[0]?.content?.parts || [];
  let imageOut = null, mimeType = 'image/png', textOut = '';
  for (const part of responseParts) {
    if (part.inlineData && part.inlineData.data) {
      imageOut = part.inlineData.data;
      mimeType = part.inlineData.mimeType || mimeType;
    } else if (part.text) {
      textOut += part.text;
    }
  }

  if (!imageOut) {
    throw new Error(textOut || 'The model did not return an image. Try rephrasing your prompt.');
  }
  return { image: `data:${mimeType};base64,${imageOut}`, text: textOut };
}

// ---- Provider: OpenRouter — dedicated Image API (many image models, incl. Gemini) ----
async function callOpenRouterImages({ apiKey, prompt, imageFile, model }) {
  const body = {
    model: (model && model.trim()) || OPENROUTER_DEFAULT_IMAGE_MODEL,
    prompt: prompt.trim()
  };

  if (imageFile) {
    const dataUrl = `data:${imageFile.mimeType};base64,${imageFile.buffer.toString('base64')}`;
    body.input_references = [{ type: 'image_url', image_url: { url: dataUrl } }];
  }

  const resp = await fetch('https://openrouter.ai/api/v1/images', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey.trim()}` },
    body: JSON.stringify(body)
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error((data && data.error && data.error.message) || `OpenRouter returned status ${resp.status}`);
  }

  const first = data?.data?.[0];
  if (!first || !first.b64_json) {
    throw new Error('OpenRouter did not return image data. Try a different model (see openrouter.ai/models?output_modalities=image).');
  }
  const mimeType = first.media_type || 'image/png';
  return { image: `data:${mimeType};base64,${first.b64_json}`, text: '' };
}

// ---- Providers: Groq / any custom OpenAI-compatible endpoint ----
// Neither Groq nor most self-hosted/OpenAI-compatible endpoints currently
// offer image *generation* — they offer fast text and, for vision models,
// image *understanding*. So this path sends the image (if any) + prompt
// to a chat-completions endpoint and returns text only, and says so
// clearly rather than pretending to produce an edited image.
async function callOpenAICompatibleVision({ apiKey, prompt, imageFile, model, baseUrl, providerLabel }) {
  const content = [{ type: 'text', text: prompt.trim() }];
  if (imageFile) {
    const dataUrl = `data:${imageFile.mimeType};base64,${imageFile.buffer.toString('base64')}`;
    content.push({ type: 'image_url', image_url: { url: dataUrl } });
  }

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey.trim()}` },
    body: JSON.stringify({
      model: (model && model.trim()) || undefined,
      messages: [{ role: 'user', content }]
    })
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error((data && data.error && data.error.message) || `${providerLabel} returned status ${resp.status}`);
  }

  const text = data?.choices?.[0]?.message?.content || '';
  if (!text) {
    throw new Error(`${providerLabel} returned an empty response.`);
  }
  return {
    text: `[${providerLabel} — text/vision analysis lang, hindi image generation]\n\n${text}`
  };
}

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
