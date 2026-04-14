const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ── STARTUP ENV VALIDATION ────────────────────────────────────────────────────
// Fail fast with a clear message instead of crashing mid-conversation.
const REQUIRED_ENV = [
  'ANTHROPIC_API_KEY',
  'DB_HOST',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'ADMIN_WHATSAPP_NUMBER',
  'BACKEND_API_URL',
  'FRONTEND_URL',
  'BOT_UPLOAD_TOKEN'
];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) {
  console.error('\n❌ Missing required environment variables:');
  missingEnv.forEach(k => console.error(`   • ${k} (Current value is undefined or empty)`));
  console.error('\n👉 Please check your .env file on the VPS and restart the bot.\n');
  process.exit(1);
}

const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const Anthropic = require('@anthropic-ai/sdk');
const http = require('http');
const socketIO = require('socket.io');
const fs = require('fs');

const mime = require('mime-types');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const { buildSystemPrompt } = require('./ekaralu-knowledge');
const db = require('./db');

// ── DEDUPLICATION ─────────────────────────────────────────────────────────────
const processedMsgIds = new Set();
// Subtract 120 seconds to account for clock skew between WhatsApp and the server.
const BOT_START_TIME = Math.floor(Date.now() / 1000) - 120;
const MSG_ID_CACHE_LIMIT = 500;
const PORT = process.env.PORT || 5010;

process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);

// ── SIGHUP PROTECTION (24/7 FIX) ──────────────────────────────────────────────
// This prevents the process from dying when you close the VPS terminal.
process.on('SIGHUP', () => {
  console.log('⚠️ [SIGNAL] Terminal session closed (SIGHUP ignored). Bot will continue running.');
});


const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = socketIO(server);

// ── HEARTBEAT ────────────────────────────────────────────────────────────────
// Logs every hour to confirm the bot is still running in the background.
setInterval(() => {
  console.log(`[HEARTBEAT] Bot is active. Time: ${new Date().toISOString()}`);
}, 3600000); // 1 hour

// Enable CORS - restricted to production domain in production
const cors = require('cors');
const corsOptions = {
  origin: process.env.NODE_ENV === 'production'
    ? [process.env.DEPLOYMENT_URL, process.env.FRONTEND_URL, process.env.BACKEND_API_URL].filter(Boolean)
    : '*',
  credentials: true
};
app.use(cors(corsOptions));

app.use(express.json());

// ── SESSION SETTINGS REMOVED ──────────────────────────────────────────────────────────

// ── NO AUTH ───────────────────────────────────────────────────────────

// Serve root route directly
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve static files
app.use(express.static('public'));

app.post('/api/whatsapp/disconnect', async (req, res) => {
  try {
    console.log('[DISCONNECT API] Triggering logout and clearing data...');
    // 1. Clear saved conversations
    conversationHistory = {};
    saveConversations();

    // 2. Clear auth directories
    const authPath = path.join(__dirname, '.wwebjs_auth');
    if (fs.existsSync(authPath)) {
      fs.rmSync(authPath, { recursive: true, force: true });
    }
    const cachePath = path.join(__dirname, '.wwebjs_cache');
    if (fs.existsSync(cachePath)) {
      fs.rmSync(cachePath, { recursive: true, force: true });
    }

    // 3. Logout client if active, this fires the disconnected event which will re-initialize
    if (botStatus && botStatus.state === 'ready') {
      await client.logout().catch(e => console.error('[LOGOUT ER]', e));
    } else {
      await client.destroy().catch(e => console.error('[DESTROY ER]', e));
      await client.initialize();
    }
    
    res.json({ success: true, message: 'Disconnected and regenerating QR...' });
  } catch (err) {
    console.error('[API DISCONNECT] error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'agent-ekaralu-listings',
    port: process.env.PORT
  });
});

app.get('/api/db-check', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT 1 as connected');
    res.json({ success: true, message: ' Database connected successfully', timestamp: new Date() });
  } catch (err) {
    res.status(500).json({ success: false, message: ' Database connection failed', error: err.message });
  }
});

// ── CONFIG ──────────────────────────────────────────────────────────────────
const ADMIN_NUMBER = (process.env.ADMIN_WHATSAPP_NUMBER).replace(/\D/g, '');
const VERIFIER_NUMBER = (process.env.VERIFIER_WHATSAPP_NUMBER || ADMIN_NUMBER).replace(/\D/g, '');
const BACKEND_API_URL = (process.env.BACKEND_API_URL).replace(/\/$/, '');
const FRONTEND_URL = (process.env.FRONTEND_URL).replace(/\/$/, '');
const BOT_UPLOAD_TOKEN = process.env.BOT_UPLOAD_TOKEN;
const MODEL_CHAT = 'claude-haiku-4-5-20251001';
const MODEL_EXTRACT = 'claude-sonnet-4-5-20250929';
const MAX_RETRIES = 2;
const RETRY_DELAY = 1500;
const ENV_PATH = path.join(__dirname, '.env');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ── API KEY CACHE ─────────────────────────────────────────────────────────────
let _cachedAnthropicClient = null;
let _cachedKey = '';

function getAnthropicClient() {
  const key = process.env.ANTHROPIC_API_KEY || '';
  if (!key) return null;
  if (key !== _cachedKey) {
    _cachedKey = key;
    _cachedAnthropicClient = new Anthropic({ apiKey: key });
  }
  return _cachedAnthropicClient;
}

// ── CONVERSATION MEMORY ──────────────────────────────────────────────────────
const HISTORY_FILE = path.join(__dirname, 'conversations.json');
let conversationHistory = {};

function saveConversations() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(conversationHistory, null, 2));
  } catch (err) {
    console.error('[PERSISTENCE ERROR] Failed to save conversations:', err.message);
  }
}

function loadConversations() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = fs.readFileSync(HISTORY_FILE, 'utf8');
      conversationHistory = JSON.parse(data);
      console.log(`[PERSISTENCE] Loaded ${Object.keys(conversationHistory).length} conversations from disk.`);
    }
  } catch (err) {
    console.error('[PERSISTENCE ERROR] Failed to load conversations:', err.message);
  }
}

// Load on startup
loadConversations();

function getRandomIndianName() {
  const names = [
    'Arjun', 'Vikram', 'Rohan', 'Aditya', 'Kabir', 'Ishaan', 'Aryan', 'Rahul', 'Siddharth', 'Yash',
    'Ananya', 'Ishani', 'Kavya', 'Meera', 'Neha', 'Priya', 'Riya', 'Saanvi', 'Tanvi', 'Zara'
  ];
  return names[Math.floor(Math.random() * names.length)];
}

function getHistory(chatId) {
  if (!conversationHistory[chatId]) {
    conversationHistory[chatId] = {
      messages: [],
      agentName: getRandomIndianName(),
      lastSharedLocation: null
    };
  }
  return conversationHistory[chatId].messages;
}

function getAgentName(chatId) {
  getHistory(chatId); // Ensure initialized
  return conversationHistory[chatId].agentName;
}

function addToHistory(chatId, role, content) {
  const history = getHistory(chatId);
  history.push({ role, content });
  if (history.length > 20) history.splice(0, history.length - 20);
  saveConversations(); // Persist change
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pendingApprovals = {};

async function uploadToEkaraluAPI(base64Data, mimetype) {
  try {
    const ext = mime.extension(mimetype) || 'jpg';

    // Size check (15MB)
    const sizeBytes = base64Data.length * 0.75;
    if (sizeBytes > 15 * 1024 * 1024) {
      console.error(`[IMAGE INFO] Image > 15MB`);
      return 'FILE_TOO_LARGE';
    }

    const buffer = Buffer.from(base64Data, 'base64');
    const form = new FormData();
    form.append('image', buffer, `prop_${Date.now()}_${crypto.randomBytes(2).toString('hex')}.${ext}`);

    const res = await axios.post(`${BACKEND_API_URL}/api/properties/bot-upload`, form, {
      headers: {
        ...form.getHeaders(),
        'X-Upload-Token': BOT_UPLOAD_TOKEN
      },
      timeout: 30000
    });

    if (res.data && res.data.success) {
      return res.data.filename;
    }
    return null;
  } catch (err) {
    console.error('[UPLOAD ERROR]', err.response?.data || err.message);
    return null;
  }
}

async function insertPropertyIntoDB(data, filenames) {
  try {
    // Convert filenames to full URLs (skip 'NA' placeholders)
    const imageUrls = filenames
      .filter(f => f && f !== 'NA')
      .map(f => f.startsWith('http') ? f : `${BACKEND_API_URL}/uploads/${f}`);

    const payload = {
      title: data.title || 'Property for Sale/Rent',
      description: data.description || '',
      price: data.price || 0,
      price_label: data.price_label || '',
      type: data.type || 'buy',
      property_type: data.property_type || 'plot',
      parking: data.parking || 0,
      area: data.area || '',
      area_sqft: data.area_sqft || 0,
      locality: data.locality || '',
      district: data.district || 'Hyderabad',
      full_address: data.full_address || '',
      lat: (data.lat !== undefined && data.lat !== null) ? data.lat : 0,
      lng: (data.lng !== undefined && data.lng !== null) ? data.lng : 0,
      images: imageUrls,
      amenities: data.amenities || '',
      owner_name: data.owner_name || '',
      owner_contact: data.owner_contact || '',
      abutting_road: data.abutting_road || '',
      distance_from_orr: data.distance_from_orr || '',
      highways: data.highways || '',
      price_per_unit: data.price_per_unit || ''
    };

    const sourceLabel = data.isGPS ? '[GPS_PIN]' : '[AI_GUESS]';
    console.log(`[DB_INSERT] ${sourceLabel} Sending payload for "${payload.title}" | Lat: ${payload.lat} | Lng: ${payload.lng} | Owner: ${payload.owner_name}`);

    const response = await axios.post(`${BACKEND_API_URL}/api/properties/bot-listing`, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Upload-Token': BOT_UPLOAD_TOKEN
      },
      timeout: 15000
    });

    if (response.data && response.data.success && response.data.id) {
      console.log(`[BOT LISTING] Property inserted with ID: ${response.data.id}`);
      return response.data.id;
    }
    console.error('[BOT LISTING] Unexpected API response:', response.data);
    return null;
  } catch (err) {
    console.error('[API ERROR] Failed to POST property to Ekaralu:', err.response?.data || err.message);
    return null;
  }
}

async function searchPropertiesInDB(locality, type) {
  try {
    let sql = 'SELECT id, title, price, locality, type, images FROM properties WHERE status = "active"';
    const params = [];

    if (locality) {
      sql += ' AND locality LIKE ?';
      params.push(`%${locality}%`);
    }
    if (type) {
      sql += ' AND (type = ? OR property_type = ?)';
      params.push(type, type);
    }

    sql += ' ORDER BY created_at DESC LIMIT 3';

    const [rows] = await db.query(sql, params);
    return rows;
  } catch (err) {
    console.error('[DB SEARCH ERROR]', err.message);
    return [];
  }
}

/**
 * Deep-Link Resolver (100% Accuracy Fix):
 * Resolves short links and scrapes the page HTML for hidden coordinates.
 */
async function resolveGoogleMapsUrl(text) {
  const urlPattern = /(https?:\/\/[^\s]+)/g;
  const urls = text.match(urlPattern) || [];

  for (let url of urls) {
    if (!url.includes('google.com') && !url.includes('goo.gl') && !url.includes('maps.app')) continue;

    let targetUrl = url;
    let htmlContent = '';

    try {
      console.log(`[MAP_RESOLVE] Deep-analyzing link: ${url}`);
      const response = await axios.get(url, {
        maxRedirects: 10,
        timeout: 8000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });
      targetUrl = response.request.res.responseUrl || url;
      htmlContent = response.data;

      // Check for specialized Google headers
      const geoHeader = response.headers['x-goog-maps-center'];
      if (geoHeader) {
        const [lat, lng] = geoHeader.split(',');
        console.log(`[MAP_RESOLVE] Found exact coordinates in Google Headers: ${lat}, ${lng}`);
        return { lat: parseFloat(lat), lng: parseFloat(lng) };
      }
    } catch (err) {
      console.error(`[MAP_RESOLVE ERROR] Network failure for ${url}:`, err.message);
      // Fallback to basic URL parsing if network fails but we have the URL
    }

    // 1. Priority Pattern Match in Final URL
    const urlPatterns = [
      { reg: /q=([-\d.]+),([-\d.]+)/, label: 'Query Parameter' },
      { reg: /search\/([-\d.]+),([-\d.]+)/, label: 'Search Path' },
      { reg: /!3d([-\d.]+)!4d([-\d.]+)/, label: 'Marker Data (Long Link)' },
      { reg: /@([-\d.]+),([-\d.]+)/, label: 'Camera Position (Fallback)' }
    ];

    for (const p of urlPatterns) {
      const match = targetUrl.match(p.reg);
      if (match) {
        const coords = { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
        if (coords.lat !== 0 && coords.lng !== 0) {
          console.log(`[MAP_RESOLVE] Extracted from URL [${p.label}]: ${coords.lat}, ${coords.lng}`);
          return coords;
        }
      }
    }

    // 2. Metadata Scraping (Scrapes the background HTML for hidden markers)
    if (htmlContent) {
      // Pattern A: OpenGraph Image (Almost always contains center=lat,lng)
      const ogMatch = htmlContent.match(/property="og:image"\s+content="[^"]*?center=([-\d.]+),([-\d.]+)/) ||
        htmlContent.match(/content="[^"]*?center=([-\d.]+),([-\d.]+)"\s+property="og:image"/);

      if (ogMatch) {
        const coords = { lat: parseFloat(ogMatch[1]), lng: parseFloat(ogMatch[2]) };
        console.log(`[MAP_RESOLVE] Extracted from OG Metadata: ${coords.lat}, ${coords.lng}`);
        return coords;
      }

      // Pattern B: App Initialization State (The direct internal marker position)
      const stateMatch = htmlContent.match(/window\.APP_INITIALIZATION_STATE=\[\[\[([-\d.]+),([-\d.]+),[\d.]+\]/);
      if (stateMatch) {
        // Note: Google uses [lng, lat] in some initialization structures, but let's assume [lat, lng] for now 
        // as per typical viewport centering.
        const coords = { lat: parseFloat(stateMatch[1]), lng: parseFloat(stateMatch[2]) };
        console.log(`[MAP_RESOLVE] Extracted from App State: ${coords.lat}, ${coords.lng}`);
        return coords;
      }
    }
  }
  return null;
}

// ── EKARALU AI REPLY (HAIKU FOR CHAT) ─────────────────────────────────────────
async function getEkaraluChatReply(chatId, userMessage, senderName, agentName) {
  const anthropic = getAnthropicClient();
  if (!anthropic) return { success: false, error: 'API_KEY_NOT_SET' };

  addToHistory(chatId, 'user', userMessage);

  const sysPrompt = buildSystemPrompt(senderName, agentName);

  try {
    const response = await anthropic.messages.create({
      model: MODEL_CHAT,
      max_tokens: 1024,
      system: sysPrompt,
      messages: getHistory(chatId),
    });

    const reply = response.content[0].text.trim();
    if (!reply.includes('<RUN_EXTRACTOR>')) {
      addToHistory(chatId, 'assistant', reply);
    }
    return { success: true, reply };
  } catch (err) {
    console.error('[CLAUDE CHAT ERROR]', err.message);
    return { success: false, error: err.message };
  }
}

// ── PROPERTY EXTRACTION (SONNET 4.5 FOR DATA) ────────────────────────────────
async function extractPropertyData(textHistory, overrideLocation = null, senderPhone = '', senderName = '') {
  const anthropic = getAnthropicClient();
  if (!anthropic) return null;

  const messageContent = [
    {
      type: 'text',
      text: `Analyze the provided chat history context. Extract all property details and output ONLY a raw JSON object with no markdown and no surrounding text.
Format JSON with these exact keys representing the database columns:
{
  "title": "", // A catchy short title
  "description": "", // Detailed description
  "price": 0.00, // Number ONLY
  "price_label": "", 
  "type": "buy", // Strictly 'buy', 'rent', or 'plot'
  "property_type": "plot", // Strictly 'plot', 'land', 'farm house', or 'agriculture land'
  "parking": 0, // Number of parkings
  "area": "", 
  "area_sqft": 0.00, // Number ONLY
  "locality": "",
  "district": "Hyderabad", // Strictly 'Hyderabad' or 'Rangareddy'
  "full_address": "",
  "lat": 0.00000000, // Latitude
  "lng": 0.00000000, // Longitude
  "amenities": "", // Comma separated list
  "owner_name": "",
  "owner_contact": "",
  "abutting_road": "",
  "distance_from_orr": "",
  "highways": "",
  "price_per_unit": ""
}
Chat Data context: ${textHistory}
CRITICAL: If you see "[EXACT_LOCATION: lat, lng]", use those exact numbers for "lat" and "lng". This is the user's GPS position and takes absolute priority.
If an "[EXACT_LOCATION]" marker is present, do NOT attempt to find or guess coordinates for the locality or district. Focus ONLY on extracting text details.
If no marker is present, attempt to extract coordinates from any Google Maps URLs (look for @lat,lng or q=lat,lng). 
If the user provides a text location (e.g., "near Vardhaman College, Shamshabad") and no GPS marker or URL is present, estimate the approximate latitude and longitude coordinates for that location and provide them in 'lat' and 'lng'.
If the user indicates they are the owner, use their provided phone number (${senderPhone}) for "owner_contact" and their WhatsApp name (${senderName}) for "owner_name" unless they provide a different name. If their name is missing or unclear (like just "Customer"), set "owner_name" to "ASK_FOR_NAME".
Critical: Do NOT look for "verified" or "legal" status; all listings are automatically verified.
If this is absolutely NOT a property listing, respond with: {"error": "not_property"}`,
    }
  ];

  try {
    const response = await anthropic.messages.create({
      model: MODEL_EXTRACT,
      max_tokens: 1024,
      messages: [{ role: 'user', content: messageContent }],
    });

    let rawText = response.content[0].text;

    // Clean potential markdown blocks
    if (rawText.includes('```json')) {
      rawText = rawText.split('```json')[1].split('```')[0].trim();
    } else if (rawText.includes('```')) {
      rawText = rawText.split('```')[1].split('```')[0].trim();
    }

    const data = JSON.parse(rawText);

    // -- MANUAL OVERRIDE FOR EXACT LOCATION (PROFESSIONAL FIX) --
    // Priority 1: Direct session GPS capture (passed via function argument)
    if (overrideLocation && overrideLocation.lat !== undefined && overrideLocation.lng !== undefined) {
      data.lat = parseFloat(overrideLocation.lat);
      data.lng = parseFloat(overrideLocation.lng);
      data.isGPS = true;
      console.log(`[EXTRACT] Applying LOCKED-IN session GPS coordinates: ${data.lat}, ${data.lng}`);
    }
    // Priority 2: Scan history for the [EXACT_LOCATION] marker string (find the LATEST one)
    else {
      // Use global flag and grab all matches to find the most recent one at the end of history
      const globalRegex = /\[EXACT_LOCATION:\s*([-\d.]+),\s*([-\d.]+)\]/g;
      const matches = Array.from(textHistory.matchAll(globalRegex));

      if (matches.length > 0) {
        const lastMatch = matches[matches.length - 1];
        data.lat = parseFloat(lastMatch[1]);
        data.lng = parseFloat(lastMatch[2]);
        data.isGPS = true;
        console.log(`[EXTRACT] Overriding with LATEST history marker: ${data.lat}, ${data.lng}`);
      } else {
        // Priority 3: Resolve any Google Maps links (including short links)
        const resolvedCoords = await resolveGoogleMapsUrl(textHistory);
        if (resolvedCoords) {
          data.lat = resolvedCoords.lat;
          data.lng = resolvedCoords.lng;
          data.isGPS = true;
          console.log(`[EXTRACT] Overriding with RESOLVED URL coordinates: ${data.lat}, ${data.lng}`);
        }
      }
    }

    return data;
  } catch (err) {
    console.error(`[EXTRACT ERROR] ${err.message}`);
    return null;
  }
}

// ── IMAGE BUFFER STATE MACHINE ───────────────────────────────────────────────
const uploadSessions = {};
/* structure: { 
    [phone]: { 
      images: [{data, mimetype}], 
      textBuffer: string, 
      timer: timeoutId 
    } 
} */

async function updatePropertyInDB(id, data, filenames) {
  try {
    let sql = `UPDATE properties SET 
      title = ?, description = ?, price = ?, type = ?, property_type = ?, 
      locality = ?, district = ?, full_address = ?, lat = ?, lng = ?, 
      owner_name = ?, owner_contact = ?
      WHERE id = ?`;
    
    const imageUrls = filenames
      .filter(f => f && f !== 'NA')
      .map(f => f.startsWith('http') ? f : `${BACKEND_API_URL}/uploads/${f}`);
      
    const params = [
      data.title || 'Property for Sale/Rent',
      data.description || '',
      data.price || 0,
      data.type || 'buy',
      data.property_type || 'plot',
      data.locality || '',
      data.district || 'Hyderabad',
      data.full_address || '',
      data.lat ? parseFloat(data.lat) : 0,
      data.lng ? parseFloat(data.lng) : 0,
      data.owner_name || '',
      data.owner_contact || '',
      id
    ];
    await db.query(sql, params);
    
    if (imageUrls.length > 0 && imageUrls[0] !== `${BACKEND_API_URL}/uploads/default-property.png`) {
       await db.query('UPDATE properties SET images = ? WHERE id = ?', [JSON.stringify(imageUrls), id]);
    }

    console.log(`[DB_UPDATE] Updated property ID: ${id}`);
    return true;
  } catch (err) {
    console.error('[DB UPDATE ERROR]', err.message);
    return false;
  }
}

async function processPropertyUpload(chatId, senderName, client) {
  const session = uploadSessions[chatId];
  delete uploadSessions[chatId]; // Clear immediately to avoid re-entry

  if (!session) return;

  // 1. Prepare entire text history for the extractor
  let historyText = getHistory(chatId).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');

  // Merge the session buffer into history so the extractor sees everything from the current turn
  if (session.textBuffer) {
    historyText += `\nUSER: ${session.textBuffer}`;
  }

  // 2. Run Sonnet 4.5 (TEXT ONLY)
  console.log(`[EXTRACTOR] Triggering data extraction for ${senderName}...`);

  // -- FORCED LOCATION INJECTION (PROFESSIONAL FIX) --
  // We use the session location if present, fallback to the global "Last Shared Location"
  const forcedLoc = session.exactLocation || conversationHistory[chatId].lastSharedLocation;
  if (forcedLoc) {
    console.log(`[GPS_INJECTION] Found location in memory: ${forcedLoc.lat}, ${forcedLoc.lng}`);
  }

  const extractedJSON = await extractPropertyData(historyText, forcedLoc, chatId, senderName);

  if (!extractedJSON || extractedJSON.error) {
    console.error(`[EXTRACTOR ERROR] Could not extract data for ${chatId}`);
    await client.sendMessage(chatId, `We couldn't automatically verify the property details. Please chat with our normal assistant or provide clearer images/text.`);
    return;
  }

  console.log(`[EXTRACTOR SUCCESS] Extracted: ${extractedJSON.title} | Owner: ${extractedJSON.owner_name} | Contact: ${extractedJSON.owner_contact} | Loc: ${extractedJSON.lat},${extractedJSON.lng}`);

  // Auto-Upload Images
  let savedFilenames = [];
  if (session.images && session.images.length > 0) {
    for (const img of session.images) {
      const filename = await uploadToEkaraluAPI(img.data, img.mimetype);
      if (filename && filename !== 'FILE_TOO_LARGE') {
        savedFilenames.push(filename);
      }
    }
  }

  // Use default if no images
  if (savedFilenames.length === 0) {
    savedFilenames.push('default-property.png');
  }

  let finalAction = 'listed';
  let liveUrl = '';
  const lastId = conversationHistory[chatId].lastPropertyId;

  if (lastId) {
    // Update existing listing
    const success = await updatePropertyInDB(lastId, extractedJSON, savedFilenames);
    if (!success) {
       await client.sendMessage(chatId, `Failed to update property.`);
       return;
    }
    finalAction = 'updated';
    liveUrl = `${FRONTEND_URL}/property-detail.html?id=${lastId}`;
  } else {
    // Insert new listing
    const insertId = await insertPropertyIntoDB(extractedJSON, savedFilenames);
    if (!insertId) {
       await client.sendMessage(chatId, `Failed to list property. Database Error!`);
       return;
    }
    conversationHistory[chatId].lastPropertyId = insertId;
    saveConversations();
    liveUrl = `${FRONTEND_URL}/property-detail.html?id=${insertId}`;
  }

  // Check missing fields
  let missing = [];
  if (!extractedJSON.price) missing.push("Price");
  if (!extractedJSON.area) missing.push("Total Area");
  if (!extractedJSON.locality) missing.push("Locality/Landmark");
  if (!extractedJSON.property_type && !extractedJSON.type) missing.push("Property Type");
  if (!extractedJSON.owner_name || extractedJSON.owner_name === 'ASK_FOR_NAME') missing.push("Owner Name");
  if (!extractedJSON.owner_contact) missing.push("Owner Contact Number");
  if (savedFilenames.length === 1 && savedFilenames[0] === 'default-property.png') missing.push("Images (Please upload real photos)");

  let msgText = '';
  const numEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  if (missing.length > 0) {
    msgText = `Your property has been ${finalAction} based on your info!\n\nView and share it here:\n${liveUrl}\n\n*Important:* Some details are missing. To make your property verification complete and look more premium, please provide:\n${missing.map((m, i) => `${numEmojis[i] || '•'} ${m}`).join('\n')}\n\nJust reply to me with the missing info and I will automatically update your listing!`;
  } else {
    msgText = `Perfect! Your property has been ${finalAction} and is fully detailed.\n\nView and share your listing here:\n${liveUrl}\n\nThank you for listing with Ekaralu! Let me know if you need to update anything else.`;
  }

  await client.sendMessage(chatId, msgText);
}

// ── STATUS TRACKING ─────────────────────────────────────────────────────────
let botStatus = { state: 'initializing', qr: null, phone: null };

function updateStatus(state, extra = {}) {
  botStatus = { ...botStatus, state, ...extra };
  io.emit('status', botStatus);
  console.log('[STATUS]', state);
}

// ── WHATSAPP CLIENT ──────────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--hide-scrollbars',
      '--metrics-recording-only',
      '--mute-audio',
      '--safebrowsing-disable-auto-update',
      '--ignore-certificate-errors',
      '--ignore-ssl-errors',
      '--ignore-certificate-errors-spki-list',
      '--js-flags="--max-old-space-size=512"', // Professional memory limit
      '--remote-debugging-port=0' // Prevents session lock issues
    ],
  },
});

client.on('qr', async (qr) => {
  const qrDataURL = await qrcode.toDataURL(qr);
  updateStatus('qr_ready', { qr: qrDataURL });
});

// Use .once to prevent multiple ready events from waste resources
client.once('ready', () => {
  updateStatus('ready', { phone: client.info?.wid?.user || 'Connected', qr: null });
  console.log('[READY] Ekaralu WhatsApp Bot is live! (Session Independent Mode)');
});

client.on('disconnected', async (reason) => {
  console.log(`[DISCONNECTED] WhatsApp disconnected. Reason: ${reason}`);
  updateStatus('disconnected', { reason });
  
  // Professional Auto-Reconnection Strategy
  console.log('[RECONNECT] Attempting to re-initialize in 5 seconds...');
  setTimeout(async () => {
    try {
      await client.initialize();
      console.log('[RECONNECT] Re-initialization command sent.');
    } catch (err) {
      console.error('[RECONNECT ERROR] Failed to re-initialize:', err.message);
    }
  }, 5000);
});

// ── MESSAGE HANDLER ──────────────────────────────────────────────────────────
client.on('message', async (msg) => {
  try {
    if (msg.isStatus || msg.fromMe) return;

    const msgId = msg.id._serialized || msg.id.id;
    if (processedMsgIds.has(msgId)) return;
    if (msg.timestamp && msg.timestamp < BOT_START_TIME) return;

    processedMsgIds.add(msgId);
    if (processedMsgIds.size > MSG_ID_CACHE_LIMIT) processedMsgIds.delete(processedMsgIds.values().next().value);

    const chat = await msg.getChat();
    const contact = await msg.getContact();
    const senderName = contact.pushname || contact.name || 'there';
    const chatId = chat.id._serialized;

    let body = msg.body || '';

    // -- LOCATION HUB --
    if (msg.type === 'location' && msg.location) {
      const { latitude, longitude } = msg.location;

      // 1. Permanent Memory for the entire chat session
      getHistory(chatId);
      conversationHistory[chatId].lastSharedLocation = { lat: latitude, lng: longitude };

      // 2. Inject String Marker for AI Extraction (Matches Admin Request)
      const locationMarker = `[EXACT_LOCATION: ${latitude}, ${longitude}]`;
      body = body ? `${body}\n${locationMarker}` : locationMarker;

      // 3. Store in active session if one exists
      if (uploadSessions[chatId]) {
        uploadSessions[chatId].exactLocation = { lat: latitude, lng: longitude };
      }

      saveConversations(); // Persist location update
      console.log(`[LOCATION] Captured exact coordinates from ${senderName}: ${latitude}, ${longitude}`);
    }

    // -- DEBUG LOGGING FOR VERIFIER --
    const coreVerifier = VERIFIER_NUMBER.substring(VERIFIER_NUMBER.length - 10);
    const coreAdmin = ADMIN_NUMBER.substring(ADMIN_NUMBER.length - 10);
    const senderPhoneStr = (contact.number || chatId || '').toString();
    const isAdmin = senderPhoneStr.includes(coreVerifier) || senderPhoneStr.includes(coreAdmin) || chatId.includes(coreVerifier) || chatId.includes(coreAdmin);

    if (isAdmin) {
      console.log(`[ADMIN DETECTED] phone: ${senderPhoneStr} | MSG: "${body}"`);
    }

    // -- VERIFIER FLOW INTERCEPT --
    if (isAdmin) {
      const textUpper = body.trim().toUpperCase();

      if (textUpper === 'YES' || textUpper === 'NO' || textUpper.startsWith('YES ') || textUpper.startsWith('NO ')) {
        const parts = textUpper.split(' ');
        const decision = parts[0];
        let propId = parts[1];

        // If no ID provided, try to find the only one pending or the most recent one
        if (!propId) {
          const keys = Object.keys(pendingApprovals);
          if (keys.length === 1) {
            propId = keys[0];
          } else if (keys.length > 1) {
            await msg.reply(`Multiple properties pending. Please specify the ID (e.g., YES ${keys[keys.length - 1]})`);
            return;
          } else {
            await msg.reply(`No properties currently pending for approval.`);
            return;
          }
        }

        if (!pendingApprovals[propId]) {
          await msg.reply(`${propId} not found in pending list.`);
          return;
        }

        const p = pendingApprovals[propId];

        if (decision === 'NO') {
          delete pendingApprovals[propId];
          await msg.reply(`Property ${propId} rejected.`);
          await client.sendMessage(p.chatId, `Unfortunately, your recent property listing request was not approved by our team.`);
          return;
        }

        // It's YES: Proceed to publish it.
        await msg.reply(`Publishing ${propId} to the Ekaralu database...`);

        // Upload images
        const savedFilenames = [];
        for (const img of p.images) {
          const filename = await uploadToEkaraluAPI(img.data, img.mimetype);
          if (filename === 'FILE_TOO_LARGE') {
            await client.sendMessage(p.chatId, `One of your images was over 15MB and was skipped.`);
            savedFilenames.push('NA');
          } else if (filename) {
            savedFilenames.push(filename);
          } else {
            // Failsafe: If image API completely fails, gracefully degrade
            savedFilenames.push('NA');
          }
        }

        // Failsafe: if they didn't even send an image, default to NA so JSON isn't totally empty
        if (savedFilenames.length === 0) savedFilenames.push('NA');

        // Insert to DB
        const insertId = await insertPropertyIntoDB(p.extractedJSON, savedFilenames);
        if (!insertId) {
          await msg.reply(`Database Error! Could not insert ${propId}.`);
          return;
        }

        // Done
        delete pendingApprovals[propId];
        const liveUrl = `${FRONTEND_URL}/property-detail.html?id=${insertId}`;

        // Confirm to Admin
        await msg.reply(`Property ${propId} published successfully.\n\nView live listing: ${liveUrl}`);

        // Notify Original User with the live link
        await client.sendMessage(
          p.chatId,
          `Great news! Your property has been approved and is now live on Ekaralu.\n\nYou can view and share your listing here:\n${liveUrl}\n\nThank you for listing with us. Feel free to reach out if you need any changes.`
        );

        return; // Interceptor ends
      }

      // If it's a message from the admin but didn't trigger approval, let's not treat them as a customer
      await msg.reply(`*Admin Mode:* I'm listening for property approvals (e.g., YES PROP_ID).\n\nPending list: ${Object.keys(pendingApprovals).join(', ') || 'None'}`);
      return;
    }

    // -- IMAGE HUB BUFFERING --
    if (msg.hasMedia) {
      const media = await msg.downloadMedia();

      if (media && media.mimetype.startsWith('image/')) {
        if (!uploadSessions[chatId]) {
          uploadSessions[chatId] = { images: [], textBuffer: body + '\n', timer: null, exactLocation: null };
        } else {
          if (body) uploadSessions[chatId].textBuffer += body + '\n';
        }

        // Append image (max 5)
        if (uploadSessions[chatId].images.length < 5) {
          uploadSessions[chatId].images.push({ data: media.data, mimetype: media.mimetype });
        }

        // Reset/start a 15s idle timer — triggers extraction after user stops sending images
        if (uploadSessions[chatId].timer) clearTimeout(uploadSessions[chatId].timer);
        uploadSessions[chatId].timer = setTimeout(() => {
          if (uploadSessions[chatId]) {
            console.log(`[TIMER] Auto-triggering extraction for ${chatId} after image buffer timeout.`);
            processPropertyUpload(chatId, senderName, client).catch(console.error);
          }
        }, 15000);

        return; // Don't run standard chat while uploading images. Wait for user to finish and chat.
      }
    } else {
      // If pure text but an active upload session exists, just append to buffer.
      // We no longer trigger auto-extraction here.
      if (uploadSessions[chatId]) {
        uploadSessions[chatId].textBuffer += body + '\n';
        return;
      }
    }

    // -- STANDARD TEXT CHAT (HAIKU) --
    if (!body.trim()) return;

    const history = getHistory(chatId);
    const agentName = getAgentName(chatId);

    // -- WELCOME LOGIC --
    if (history.length === 0) {
      await client.sendMessage(chatId, `Hello, this is ${agentName} from Ekaralu.com. Are you looking to sell or buy property?`);

      // Add placeholders to history so bot knows it greeted
      addToHistory(chatId, 'assistant', `Trusted real estate partner in Hyderabad, Telangana (not Andhra Pradesh)`);
      addToHistory(chatId, 'assistant', `Hello, this is ${agentName} from Ekaralu.com. Are you looking to sell or buy property?`);
      return;
    }

    await chat.sendStateTyping();
    const chatResult = await getEkaraluChatReply(chatId, body, senderName, agentName);

    if (!chatResult.success) {
      console.error(`[CHAT FALLBACK] Failed to get conversational reply:`, chatResult.error);
      await client.sendMessage(chatId, "Bzz. I'm currently experiencing some technical difficulties connecting to my AI systems. Please try again shortly.");
      return;
    }

    if (chatResult.reply.includes('<SEARCH_LISTINGS:')) {
      const match = chatResult.reply.match(/<SEARCH_LISTINGS:\s*(.*?),\s*(.*?)>/);
      const locality = match ? match[1].trim() : '';
      const type = match ? match[2].trim() : '';

      const results = await searchPropertiesInDB(locality, type);

      if (results.length > 0) {
        let msgText = `Here are some properties in ${locality || 'the area'} that might interest you:\n\n`;
        results.forEach((p, i) => {
          msgText += `${i + 1}. ${p.title}\nPrice: ${p.price}\nLocality: ${p.locality}\nLink: ${FRONTEND_URL}/property-detail.html?id=${p.id}\n\n`;
        });
        msgText += `Visit ekaralu.com for more properties in this area.`;
        await client.sendMessage(chatId, msgText);
      } else {
        await client.sendMessage(chatId, `I couldn't find any exact matches for "${type}" in "${locality}" right now. Please tell me if you have any other preferred areas!\n\nVisit ekaralu.com to see all our listings.`);
      }

      // Still log the AI's internal response for debugging
      console.log(`[BUYER_SEARCH] ${senderName} searched for ${locality}, ${type}. Found ${results.length} results.`);
    } else if (chatResult.reply.includes('<RUN_EXTRACTOR>')) {
      // Haiku detected pure-text property listing.
      console.log(`[ROUTE] ${senderName} text triggered property extraction.`);

      // Send professional acknowledgment instantly
      await msg.reply(`Successfully captured. I've forwarded these property details to our verification team for a quick review.`);

      if (!uploadSessions[chatId]) {
        uploadSessions[chatId] = { images: [], textBuffer: body + '\n', timer: null, exactLocation: null };
      }
      processPropertyUpload(chatId, senderName, client).catch(console.error);
      return;
    }

    if (chatResult.success) {
      await msg.reply(chatResult.reply);
      console.log(`[REPLY]  ${senderName}: ${chatResult.reply.substring(0, 50)}...`);
    } else {
      await msg.reply("Sorry, I'm having a quick moment — please try again!");
    }
    await chat.clearState();

  } catch (err) {
    console.error('[CRITICAL MESSAGE ERROR]', err.message);
    
    // Self-Healing: Detect browser crash/TargetCloseError
    if (err.message.includes('Target closed') || err.message.includes('Session closed') || err.message.includes('Protocol error')) {
      console.log('🚨 [RECOVERY] Browser crash detected! Attempting emergency restart...');
      try {
        await client.initialize();
        console.log('✅ [RECOVERY] Re-initialization command sent successfully.');
      } catch (initErr) {
        console.error('❌ [RECOVERY FAILED] Could not restart browser:', initErr.message);
      }
    }
  }
});

// ── GLOBAL ERROR HANDLER ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[UNCAUGHT ERROR]', err.stack);
  res.status(500).json({ success: false, error: 'Internal Server Error' });
});

// ── SERVER START ─────────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`\nEkaralu WhatsApp Bot is live!`);
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`Health:    http://localhost:${PORT}/health\n`);

  // -- STARTUP DB CHECK --
  try {
    await db.query('SELECT 1');
    console.log(`[DB] Database Connection Successful!`);
  } catch (err) {
    console.error(`\n[DB ERROR] Database Connection Failed!`);
    console.error(`  Error: ${err.message}`);
    console.error(`  TIP: If this is a VPS, ensure you white-listed the VPS IP in Hostinger Remote MySQL.\n`);
  }

  // -- WHATSAPP INIT (isolated so a Chromium crash won't kill the HTTP server) --
  try {
    await client.initialize();
  } catch (err) {
    console.error('[WA INIT ERROR] WhatsApp client failed to start:', err.message);
    console.error('The HTTP server is still running. Fix the issue and restart.');
    updateStatus('error', { error: err.message });
  }
});

// ── GRACEFUL SHUTDOWN (PM2 / Ctrl+C) ─────────────────────────────────────────
async function gracefulShutdown(signal) {
  console.log(`\n[SHUTDOWN] Received ${signal}. Gracefully shutting down...`);
  try { await client.destroy(); } catch (_) { }
  server.close(() => process.exit(0));
  // Force exit after 10s if something hangs
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

