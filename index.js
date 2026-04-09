require('dotenv').config();
const qrcode = require('qrcode-terminal');
const { Client, RemoteAuth, LocalAuth, Poll } = require('whatsapp-web.js');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const he = require('he');

// ==== CONFIGURATION ====
const TARGET_PHONE_NUMBER = process.env.TARGET_PHONE_NUMBER || '919930488938'; 
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 9 * * *';
const FLASHCARD_SCHEDULE = process.env.FLASHCARD_SCHEDULE || '0 20 * * *'; // 8 PM daily
const FLASHCARDS_PER_DAY = parseInt(process.env.FLASHCARDS_PER_DAY) || 10;
const MONGODB_URI = process.env.MONGODB_URI;
const USE_REMOTE_AUTH = process.env.USE_REMOTE_AUTH === 'true';
// =======================

// Render expects web services to bind to a port, otherwise the deployment fails.
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WhatsApp Quiz Bot is running!\n');
}).listen(PORT, () => {
    console.log(`Web server listening on port ${PORT} (Required for Render health checks)`);
});

let currentQuiz = []; // Store the latest quiz for answer verification globally
let flashcardIndex = 0; // Track which flashcards have been sent

async function startBot() {
    let authStrategy;

    if (USE_REMOTE_AUTH && MONGODB_URI) {
        // Cloud deployment mode: use MongoDB for session persistence
        const mongoose = require('mongoose');
        const { MongoStore } = require('wwebjs-mongo');
        
        console.log('Connecting to MongoDB for RemoteAuth...');
        // Retry connection up to 5 times with delay
        let connected = false;
        for (let attempt = 1; attempt <= 5; attempt++) {
            try {
                await mongoose.connect(MONGODB_URI, { family: 4 }); // Force IPv4
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
        
        const store = new MongoStore({ mongoose: mongoose });
        authStrategy = new RemoteAuth({
            clientId: 'flashcard-bot',
            store: store,
            backupSyncIntervalMs: 300000 // 5 minutes
        });
    } else {
        // Local testing mode: use file-based session
        console.log('Using LocalAuth (file-based session). No MongoDB needed.');
        authStrategy = new LocalAuth();
    }

    const client = new Client({
        authStrategy: authStrategy,
        puppeteer: {
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--single-process'
            ]
        }
    });

    let isReady = false;

    client.on('qr', (qr) => {
        console.log('\n--- ACTION REQUIRED ---');
        console.log('Please scan the QR code below using your WhatsApp (Linked Devices):');
        qrcode.generate(qr, { small: false });
        console.log('\n======================================================');
        console.log('🛑 TERMINAL QR NOT WORKING OR DEFORMED? 🛑');
        console.log('Copy this URL and open it in a new browser tab to see a perfect QR Code:');
        console.log(`https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`);
        console.log('======================================================\n');
    });

    if (USE_REMOTE_AUTH) {
        client.on('remote_session_saved', () => {
            console.log('WhatsApp Session successfully securely saved to MongoDB!');
        });
    }

    client.on('authenticated', () => {
        console.log('✅ WhatsApp authenticated successfully!');
    });

    client.on('auth_failure', (msg) => {
        console.error('❌ Authentication failed:', msg);
    });

    client.on('ready', () => {
        console.log('🚀 WhatsApp Client is ready! Dashboard connected.');
        isReady = true;

        // Set up the daily flashcard cron job
        cron.schedule(FLASHCARD_SCHEDULE, () => {
            console.log(`[${new Date().toLocaleString()}] Running scheduled job to send flashcards...`);
            sendFlashcards(client);
        });
        
        console.log(`Flashcards scheduled: ${FLASHCARD_SCHEDULE}`);
        console.log('Type "flash" to send flashcards now.');
    });

    // Handle ALL messages (including your own) for answer verification
    // Using 'message_create' instead of 'message' because when you message your own number,
    // 'message' only fires for incoming messages from OTHER people.
    client.on('message_create', async (msg) => {
        const from = msg.from;
        const to = msg.to;
        const body = msg.body.trim().toUpperCase();

        // Ignore newsletters, groups, status broadcasts — only handle personal chats (@c.us)
        if (from.includes('@newsletter') || from.includes('@g.us') || from.includes('@broadcast')) return;
        if (to && (to.includes('@newsletter') || to.includes('@g.us') || to.includes('@broadcast'))) return;

        // Only process messages in the self-chat (messages you send to yourself)
        const selfChatId = `${TARGET_PHONE_NUMBER}@c.us`;
        if (from !== selfChatId && to !== selfChatId) return;

        // Only process short commands — ignore long messages (like the quiz itself)
        if (body.length > 10) return;

        console.log(`📩 Received command: "${body}" (from: ${from}, fromMe: ${msg.fromMe})`);

        // Handle simple answer checking (A, B, C, D)
        if (['A', 'B', 'C', 'D'].includes(body)) {
            if (currentQuiz.length === 0) {
                await client.sendMessage(selfChatId, "No active quiz found. Wait for the next scheduled trivia!");
                return;
            }

            await client.sendMessage(selfChatId, "Thanks for your answer! I'm currently in 'Broadcast Mode'. In the next version, I'll track your score individually. \n\nCheck the spoiler in the trivia message to see if you were right! ✅");
        } else if (body === 'HELP') {
            await client.sendMessage(selfChatId, "I'm the Trivia Bot! 🤖\n\nI send 10 trivia questions daily. You can reply with A, B, C, or D to practice (though I don't track scores yet!).\n\nType 'TEST' in my server console to trigger questions manually.");
        }
    });

    // Handle terminal input (Local only)
    process.stdin.on('data', (data) => {
        const input = data.toString().trim().toLowerCase();
        if (!isReady) {
            console.log("Client is not ready yet. Please wait or authenticate.");
            return;
        }
        if (input === 'flash') {
            console.log("Manual test triggered. Sending flashcards now...");
            sendFlashcards(client);
        }
    });

    console.log('Initializing WhatsApp client... (this may take a moment)');
    client.initialize();
}

startBot().catch(err => {
    console.error("Failed to start bot:", err);
});

function formatQuestions(questions) {
    let messageBody = `*🧠 Daily Trivia Questions!*\n\n`;
    
    questions.forEach((q, index) => {
        messageBody += `*Q${index + 1}:* ${q.question}\n\n`;
    });
    messageBody += `\n━━━━━━━━━━━━━━━━━━━━\n`;
    messageBody += `_Think you know the answers? Scroll down to check!_\n\n\n\n\n\n\n\n\n\n`;
    messageBody += `*📝 Answers:*\n`;
    questions.forEach((q, index) => {
        messageBody += `*Q${index + 1}:* ${q.answer}\n`;
    });
    
    return messageBody;
}

async function fetchQuestionsFromAPI() {
    try {
        console.log('Fetching questions from Open Trivia DB...');
        const response = await fetch('https://opentdb.com/api.php?amount=10&type=multiple');
        const data = await response.json();

        if (data.response_code !== 0) {
            throw new Error(`API returned error code: ${data.response_code}`);
        }

        return data.results.map(q => {
            const decodedQuestion = he.decode(q.question);
            const correctAnswer = he.decode(q.correct_answer);
            const incorrectAnswers = q.incorrect_answers.map(ansi => he.decode(ansi));
            
            // Combine and shuffle options
            const options = [...incorrectAnswers, correctAnswer].sort(() => Math.random() - 0.5);

            return {
                question: decodedQuestion,
                options: options,
                answer: correctAnswer
            };
        });
    } catch (error) {
        console.error('Failed to fetch from API, falling back to local questions:', error.message);
        try {
            const rawData = fs.readFileSync('questions.json');
            return JSON.parse(rawData);
        } catch (fsError) {
            console.error('Local questions file also failed:', fsError.message);
            return [];
        }
    }
}

async function sendQuestions(client) {
    try {
        const chatId = `${TARGET_PHONE_NUMBER}@c.us`;
        
        // Fetch questions dynamically
        const questions = await fetchQuestionsFromAPI();
        
        if (questions.length === 0) {
            console.log("No questions available!");
            return;
        }

        // Store globally for message listener to access
        currentQuiz = questions;
        
        const messageText = formatQuestions(questions);
        
        console.log(`Sending trivia to ${chatId}...`);
        await client.sendMessage(chatId, messageText);
        console.log('Trivia sent successfully!');
    } catch (error) {
        console.error('Failed to send trivia:', error);
    }
}

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
        .replace(/\\/g, '');                  // Remove remaining backslashes
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

async function sendFlashcards(client) {
    try {
        const chatId = `${TARGET_PHONE_NUMBER}@c.us`;
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
        await client.sendMessage(chatId, messageText);
        console.log('Flashcards sent successfully!');
    } catch (error) {
        console.error('Failed to send flashcards:', error);
    }
}
