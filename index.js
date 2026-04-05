require('dotenv').config();
const qrcode = require('qrcode-terminal');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const cron = require('node-cron');
const fs = require('fs');
const http = require('http');

// ==== CONFIGURATION ====
const TARGET_PHONE_NUMBER = process.env.TARGET_PHONE_NUMBER || '919930488938'; 
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 9 * * *';
const MONGODB_URI = process.env.MONGODB_URI;
// =======================

if (!MONGODB_URI) {
    console.error("FATAL ERROR: MONGODB_URI environment variable is missing.");
    console.error("Please create a .env file locally, or set it up in your Render Environment Variables.");
    process.exit(1);
}

// Render expects web services to bind to a port, otherwise the deployment fails.
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WhatsApp Quiz Bot is running!\n');
}).listen(PORT, () => {
    console.log(`Web server listening on port ${PORT} (Required for Render health checks)`);
});

// Connect to MongoDB to store WhatsApp Session
mongoose.connect(MONGODB_URI).then(() => {
    console.log('Connected to MongoDB. Initializing WhatsApp Client...');
    
    const store = new MongoStore({ mongoose: mongoose });
    const client = new Client({
        authStrategy: new RemoteAuth({
            store: store,
            backupSyncIntervalMs: 300000 // 5 minutes
        }),
        puppeteer: {
            // Use the system-installed Chrome in Docker, or bundled Chromium locally
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        }
    });

    let isReady = false;

    client.on('qr', (qr) => {
        console.log('--- ACTION REQUIRED ---');
        console.log('Please scan the QR code below using your WhatsApp (Linked Devices):');
        qrcode.generate(qr, { small: true });
        console.log('NOTE: If you are deploying to Render, you must read this QR code from the Render Logs window!');
        console.log('-----------------------');
    });

    client.on('remote_session_saved', () => {
        console.log('WhatsApp Session successfully securely saved to MongoDB!');
    });

    client.on('ready', () => {
        console.log('WhatsApp Client is ready! Dashboard connected.');
        isReady = true;
        
        // Set up the daily cron job
        cron.schedule(CRON_SCHEDULE, () => {
            console.log(`[${new Date().toLocaleString()}] Running scheduled job to send questions...`);
            sendQuestions(client);
        });
        
        console.log(`Cron job scheduled. Waiting for ${CRON_SCHEDULE} to trigger...`);
    });

    // Handle terminal input so the user can type "test" to see it working instantly (Local only)
    process.stdin.on('data', (data) => {
        const input = data.toString().trim();
        if (input === 'test') {
            if (!isReady) {
                console.log("Client is not ready yet. Please wait or authenticate.");
                return;
            }
            console.log("Manual test triggered. Sending questions now...");
            sendQuestions(client);
        }
    });

    client.initialize();
}).catch(err => {
    console.error("Failed to connect to MongoDB:", err);
});

function formatQuestions(questions) {
    let messageBody = `*Daily Trivia Questions!*\n\n`;
    
    questions.forEach((q, index) => {
        messageBody += `*Q${index + 1}: ${q.question}*\n`;
        q.options.forEach((opt, optIndex) => {
            const letter = String.fromCharCode(65 + optIndex); // A, B, C, D
            messageBody += `${letter}) ${opt}\n`;
        });
        messageBody += `\n`;
    });
    messageBody += `_Reply with your answers! Don't peek if you don't want to know the answers yet._\n\n`;
    messageBody += `*Spoiler - Answers below:*\n`;
    questions.forEach((q, index) => {
        messageBody += `Q${index + 1}: ${q.answer}\n`;
    });
    
    return messageBody;
}

async function sendQuestions(client) {
    try {
        const chatId = `${TARGET_PHONE_NUMBER}@c.us`;
        
        // Read questions from JSON file
        const rawData = fs.readFileSync('questions.json');
        let questions = JSON.parse(rawData);
        
        if (questions.length === 0) {
            console.log("No questions found in questions.json!");
            return;
        }

        const selectedQuestions = questions.slice(0, 10);
        const messageText = formatQuestions(selectedQuestions);
        
        console.log(`Sending message to ${chatId}...`);
        await client.sendMessage(chatId, messageText);
        console.log('Message sent successfully!');
    } catch (error) {
        console.error('Failed to send message:', error);
    }
}
