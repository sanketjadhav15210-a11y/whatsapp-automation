# Simple Node.js image — no Chrome/Puppeteer needed!
FROM node:22-slim

WORKDIR /app

# Copy package files first for better Docker layer caching
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --omit=dev

# Copy the rest of the application code
COPY . .

# Expose the port for Render health checks
EXPOSE 3000

# Start the bot
CMD ["node", "index.js"]
