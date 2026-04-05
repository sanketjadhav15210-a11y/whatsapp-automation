# Use the official Puppeteer image which comes with Chrome and all OS dependencies pre-installed.
FROM ghcr.io/puppeteer/puppeteer:24.2.1

# Set the working directory inside the container
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
