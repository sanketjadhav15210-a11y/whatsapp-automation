require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, initAuthCreds } = require('@whiskeysockets/baileys');
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
let pairingCode = null;
let sockRef = null;
let flashcardIndex = 0;

// Web server for Render health checks + controls
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
    } else if (botStatus === 'pairing' && pairingCode) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="background:#111;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:monospace">
            <h1 style="font-size:2em">📱 Link WhatsApp</h1>
            <p style="font-size:1.2em">Open WhatsApp → Linked Devices → Link a Device</p>
            <p style="font-size:1.2em">→ Tap <b>"Link with phone number instead"</b></p>
            <p style="font-size:1.2em">→ Enter your phone number, then enter this code:</p>
            <h1 style="font-size:4em;color:#0f0;letter-spacing:10px;margin:30px">${pairingCode}</h1>
            <p style="color:#888">This code is valid for ~60 seconds. Refresh page if expired.</p>
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
    // Define mongoose schema for storing auth state in MongoDB
    const authSchema = new mongoose.Schema({
        key: { type: String, unique: true },
        value: mongoose.Schema.Types.Mixed
    });
    AuthState = mongoose.model('BaileysAuth', authSchema);
}

async function mongoAuthState() {
    const writeData = async (key, data) => {
        await AuthState.updateOne({ key }, { key, value: data }, { upsert: true });
    };
    const readData = async (key) => {
        const doc = await AuthState.findOne({ key });
        return doc ? doc.value : null;
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
        // Retry connection up to 5 times with delay
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
        // Local file-based auth
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

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, console.log)
            },
            printQRInTerminal: false, // We use pairing code instead
            browser: ['Flashcard Bot', 'Chrome', '10.0'],
        });

        // Request pairing code if not registered
        if (!sock.authState.creds.registered) {
            // Wait for connection to be ready for pairing
            await new Promise(r => setTimeout(r, 2000));
            
            const phoneNumber = TARGET_PHONE_NUMBER.replace(/[^0-9]/g, '');
            console.log(`Requesting pairing code for ${phoneNumber}...`);
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                const formattedCode = code.match(/.{1,4}/g).join('-');
                pairingCode = formattedCode;
                botStatus = 'pairing';
                
                console.log(`\n========================================`);
                console.log(`📱 PAIRING CODE: ${formattedCode}`);
                console.log(`========================================`);
                console.log(`WhatsApp → Linked Devices → Link a Device`);
                console.log(`→ "Link with phone number instead"`);
                console.log(`→ Enter code: ${formattedCode}`);
                console.log(`========================================\n`);
                console.log(`Or visit: https://whatsapp-flashcard-bot.onrender.com`);
            } catch (err) {
                console.error('Failed to get pairing code:', err);
            }
        }

        // Handle connection updates
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
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
                        await AuthState.deleteMany({});
                    } else {
                        fs.rmSync(path.join(__dirname, '.wwebjs_auth'), { recursive: true, force: true });
                    }
                    console.log('Auth state cleared. Exiting to trigger Render restart...');
                    process.exit(1);
                }
            } else if (connection === 'open') {
                console.log('✅ WhatsApp connected successfully!');
                console.log('🚀 Bot is ready!');
                botStatus = 'ready';
                pairingCode = null;
                sockRef = sock;

                // Set up the daily flashcard cron job
                cron.schedule(FLASHCARD_SCHEDULE, () => {
                    console.log('⏰ Scheduled flashcard time! Sending...');
                    sendFlashcards(sock);
                });
                console.log(`Flashcards scheduled: ${FLASHCARD_SCHEDULE}`);
            }
        });

        // Save credentials whenever they update
        sock.ev.on('creds.update', saveCreds);

        // Handle terminal input (Local only)
        process.stdin.on('data', (data) => {
            const input = data.toString().trim().toLowerCase();
            if (botStatus !== 'ready') {
                console.log("Bot is not ready yet. Please wait.");
                return;
            }
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
    // Remove LaTeX delimiters and clean up for WhatsApp readability
    return text
        .replace(/\$([^$]+)\$/g, '$1')       // Remove $ delimiters
        .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '($1 / $2)') // \frac{a}{b} -> (a / b)
        .replace(/\\Sigma_\{([^}]+)\}/g, 'Σ_$1')  // \Sigma_{s} -> Σ_s
        .replace(/\\Sigma/g, 'Σ')             // \Sigma -> Σ
        .replace(/\\xi/g, 'ξ')               // \xi -> ξ
        .replace(/\\text\{([^}]+)\}/g, '$1')  // \text{barns} -> barns
        .replace(/\^\{([^}]+)\}/g, '^$1')     // ^{2} -> ^2
        .replace(/_\{([^}]+)\}/g, '_$1')      // _{s} -> _s
        .replace(/\\circ/g, '°')             // \circ -> °
        .replace(/\\\\/g, '');                  // Remove remaining backslashes
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
            
            // Skip header row
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i];
                // Parse CSV with quoted fields
                const match = line.match(/^"([^"]*)","([^"]*)"$/);
                if (match) {
                    allCards.push({
                        front: cleanLatex(match[1]),
                        back: cleanLatex(match[2])
                    });
                }
            }
        }
        
        console.log(`Loaded ${allCards.length} flashcards from ${files.length} CSV file(s).`);
    } catch (error) {
        console.error('Error loading flashcards:', error.message);
    }

    return allCards;
}

function formatFlashcards(cards) {
    let messageBody = `*📚 Daily Flashcard Review!*\n\n`;
    
    cards.forEach((card, index) => {
        messageBody += `*${index + 1}.* ${card.front}\n\n`;
    });
    messageBody += `\n━━━━━━━━━━━━━━━━━━━━\n`;
    messageBody += `_Scroll down for answers!_\n\n\n\n\n\n\n\n\n\n`;
    messageBody += `*📝 Answers:*\n`;
    cards.forEach((card, index) => {
        messageBody += `*${index + 1}.* ${card.back}\n\n`;
    });
    
    return messageBody;
}

async function sendFlashcards(sock) {
    try {
        const chatId = `${TARGET_PHONE_NUMBER}@s.whatsapp.net`;
        const allCards = loadFlashcards();
        
        if (allCards.length === 0) {
            console.log("No flashcards found in flashcards/moderator/");
            return;
        }

        // Wrap around if we've gone through all cards
        if (flashcardIndex >= allCards.length) {
            flashcardIndex = 0;
            console.log('All flashcards reviewed! Starting from the beginning.');
        }

        // Pick the next batch
        const batch = allCards.slice(flashcardIndex, flashcardIndex + FLASHCARDS_PER_DAY);
        flashcardIndex += batch.length;
        
        const messageText = formatFlashcards(batch);
        
        console.log(`Sending ${batch.length} flashcards (${flashcardIndex}/${allCards.length} total)...`);
        await sock.sendMessage(chatId, { text: messageText });
        console.log('Flashcards sent successfully!');
    } catch (error) {
        console.error('Failed to send flashcards:', error);
    }
}
