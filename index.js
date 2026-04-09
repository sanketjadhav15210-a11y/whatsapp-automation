require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const pino = require('pino');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const mongoose = require('mongoose');

// ==== CONFIGURATION ====
const TARGET_PHONE_NUMBER = process.env.TARGET_PHONE_NUMBER || '919930488938'; 
const FLASHCARD_SCHEDULE = process.env.FLASHCARD_SCHEDULE || '0 20 * * *'; // 8 PM daily
const FLASHCARDS_PER_DAY = parseInt(process.env.FLASHCARDS_PER_DAY) || 10;
const MONGODB_URI = process.env.MONGODB_URI;
const USE_REMOTE_AUTH = process.env.USE_REMOTE_AUTH === 'true';
// =======================

// State variables
let botStatus = 'starting';
let latestQRUrl = null;
let sockRef = null;
let flashcardIndex = 0;

// Web server for Render health checks + display QR
const PORT = process.env.PORT || 3000;
http.createServer(async (req, res) => {
    const url = req.url;
    
    if (url === '/send' && botStatus === 'ready' && sockRef) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body style="background:#111;color:#0f0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;font-size:1.5em"><h1>📚 Sending flashcards now! Check WhatsApp.</h1></body></html>');
        sendFlashcards(sockRef);
        return;
    }
    
    if (botStatus === 'ready') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body style="background:#111;color:#0f0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:monospace;font-size:1.5em"><h1>✅ Bot is connected and running!</h1><p><a href="/send" style="color:#0ff;font-size:0.8em">Click here to send flashcards now</a></p></body></html>');
    } else if (botStatus === 'pairing' && latestQRUrl) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><head><meta http-equiv="refresh" content="5"></head><body style="background:#111;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:monospace">
            <h1 style="font-size:2em">📱 Scan QR with WhatsApp</h1>
            <p style="font-size:1.2em">Open WhatsApp → Linked Devices → Link a Device</p>
            <img src="${latestQRUrl}" style="border:10px solid white;border-radius:12px;margin:20px;width:350px;height:350px;">
            <p style="color:#888">QR code auto-updates every 5 seconds</p>
        </body></html>`);
    } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><meta http-equiv="refresh" content="5"></head><body style="background:#111;color:#ff0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;font-size:1.5em"><h1>⏳ Starting up... (auto-refreshing)</h1></body></html>');
    }
}).listen(PORT, () => {
    console.log(`Web server listening on port ${PORT} (Required for Render health checks)`);
});

// ==== MongoDB Auth Store (for cloud persistence) ====
let AuthState;
if (USE_REMOTE_AUTH && MONGODB_URI) {
    const authSchema = new mongoose.Schema({
        key: { type: String, unique: true },
        value: String
    });
    AuthState = mongoose.model('BaileysAuth', authSchema);
}

async function mongoAuthState() {
    const writeData = async (key, data) => {
        await AuthState.updateOne({ key }, { key, value: JSON.stringify(data, BufferJSON.replacer) }, { upsert: true });
    };
    const readData = async (key) => {
        const doc = await AuthState.findOne({ key });
        try {
            return doc ? JSON.parse(doc.value, BufferJSON.reviver) : null;
        } catch (e) {
            // If the old format was saved or JSON parsing fails, wipe it
            await AuthState.deleteOne({ key });
            return null;
        }
    };
    const removeData = async (key) => {
        await AuthState.deleteOne({ key });
    };

    const creds = await readData('creds');
    
    return {
        state: {
            creds: creds || initAuthCreds(),
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        const value = await readData(`${type}-${id}`);
                        if (value) {
                            data[id] = value;
                        }
                    }
                    return data;
                },
                set: async (data) => {
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            if (value) {
                                await writeData(`${category}-${id}`, value);
                            } else {
                                await removeData(`${category}-${id}`);
                            }
                        }
                    }
                }
            }
        },
        saveCreds: async (creds) => {
            await writeData('creds', creds);
        }
    };
}

// ==== MAIN BOT ====
async function startBot() {
    let state, saveCreds;

    if (USE_REMOTE_AUTH && MONGODB_URI) {
        console.log('Connecting to MongoDB for auth persistence...');
        let connected = false;
        for (let attempt = 1; attempt <= 5; attempt++) {
            try {
                await mongoose.connect(MONGODB_URI, { family: 4 });
                console.log('Connected to MongoDB.');
                connected = true;
                break;
            } catch (err) {
                console.log(`MongoDB connection attempt ${attempt}/5 failed: ${err.code || err.message}`);
                if (attempt < 5) {
                    console.log('Retrying in 5 seconds...');
                    await new Promise(r => setTimeout(r, 5000));
                }
            }
        }
        if (!connected) throw new Error('Could not connect to MongoDB after 5 attempts.');

        const auth = await mongoAuthState();
        state = auth.state;
        saveCreds = auth.saveCreds;
    } else {
        console.log('Using local file-based auth.');
        const authDir = path.join(__dirname, '.wwebjs_auth', 'baileys_auth');
        if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
        const auth = await useMultiFileAuthState(authDir);
        state = auth.state;
        saveCreds = auth.saveCreds;
    }

    async function connectToWhatsApp() {
        const { version } = await fetchLatestBaileysVersion();
        console.log(`Using WA version: ${version.join('.')}`);

        const logger = pino({ level: 'silent' });

        const sock = makeWASocket({
            logger,
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            printQRInTerminal: true, // Output to log to make debugging easier
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            syncFullHistory: false // Keep memory low
        });

        // Handle connection updates
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                // If a QR code is generated, serve it via the web page!
                botStatus = 'pairing';
                latestQRUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
                console.log('\n========================================');
                console.log('📱 GO TO YOUR RENDER URL TO SCAN THE QR CODE');
                console.log('========================================\n');
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                console.log(`Connection closed. Reason: ${reason}`);
                
                if (reason !== DisconnectReason.loggedOut) {
                    console.log('Reconnecting...');
                    await new Promise(r => setTimeout(r, 3000));
                    connectToWhatsApp();
                } else {
                    console.log('Logged out (401). Clearing auth state and restarting...');
                    if (USE_REMOTE_AUTH && MONGODB_URI) {
                        try { await AuthState.deleteMany({}); } catch(e) {}
                    } else {
                        try { fs.rmSync(path.join(__dirname, '.wwebjs_auth'), { recursive: true, force: true }); } catch(e) {}
                    }
                    console.log('Auth state cleared. Exiting to trigger Render restart...');
                    process.exit(1);
                }
            } else if (connection === 'open') {
                console.log('✅ WhatsApp connected successfully!');
                console.log('🚀 Bot is ready!');
                botStatus = 'ready';
                latestQRUrl = null; // Clear QR
                sockRef = sock;

                cron.schedule(FLASHCARD_SCHEDULE, () => {
                    console.log('⏰ Scheduled flashcard time! Sending...');
                    sendFlashcards(sock);
                });
                console.log(`Flashcards scheduled: ${FLASHCARD_SCHEDULE}`);
            }
        });

        sock.ev.on('creds.update', saveCreds);

        process.stdin.on('data', (data) => {
            const input = data.toString().trim().toLowerCase();
            if (botStatus !== 'ready') return;
            if (input === 'flash') {
                console.log("Manual test triggered. Sending flashcards now...");
                sendFlashcards(sock);
            }
        });
    }

    await connectToWhatsApp();
}

startBot().catch(err => {
    console.error("Failed to start bot:", err);
});

// ==== FLASHCARD SYSTEM ====

function cleanLatex(text) {
    return text
        .replace(/\$([^$]+)\$/g, '$1')
        .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '($1 / $2)')
        .replace(/\\Sigma_\{([^}]+)\}/g, 'Σ_$1')
        .replace(/\\Sigma/g, 'Σ')
        .replace(/\\xi/g, 'ξ')
        .replace(/\\text\{([^}]+)\}/g, '$1')
        .replace(/\^\{([^}]+)\}/g, '^$1')
        .replace(/_\{([^}]+)\}/g, '_$1')
        .replace(/\\circ/g, '°')
        .replace(/\\\\/g, '');
}

function loadFlashcards() {
    const flashcardsDir = path.join(__dirname, 'flashcards', 'moderator');
    let allCards = [];

    try {
        const files = fs.readdirSync(flashcardsDir).filter(f => f.endsWith('.csv'));
        for (const file of files) {
            const filePath = path.join(flashcardsDir, file);
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n').filter(line => line.trim());
            for (let i = 1; i < lines.length; i++) {
                const match = lines[i].match(/^"([^"]*)","([^"]*)"$/);
                if (match) {
                    allCards.push({ front: cleanLatex(match[1]), back: cleanLatex(match[2]) });
                }
            }
        }
    } catch (error) {
        console.error('Error loading flashcards:', error.message);
    }
    return allCards;
}

function formatFlashcards(cards) {
    let messageBody = `*📚 Daily Flashcard Review!*\n\n`;
    cards.forEach((card, index) => { messageBody += `*${index + 1}.* ${card.front}\n\n`; });
    messageBody += `\n━━━━━━━━━━━━━━━━━━━━\n_Scroll down for answers!_\n\n\n\n\n\n\n\n\n\n*📝 Answers:*\n`;
    cards.forEach((card, index) => { messageBody += `*${index + 1}.* ${card.back}\n\n`; });
    return messageBody;
}

async function sendFlashcards(sock) {
    try {
        const chatId = `${TARGET_PHONE_NUMBER}@s.whatsapp.net`;
        const allCards = loadFlashcards();
        if (allCards.length === 0) return;

        if (flashcardIndex >= allCards.length) {
            flashcardIndex = 0;
        }

        const batch = allCards.slice(flashcardIndex, flashcardIndex + FLASHCARDS_PER_DAY);
        flashcardIndex += batch.length;
        
        const messageText = formatFlashcards(batch);
        await sock.sendMessage(chatId, { text: messageText });
        console.log(`Flashcards sent successfully!`);
    } catch (error) {
        console.error('Failed to send flashcards:', error);
    }
}
