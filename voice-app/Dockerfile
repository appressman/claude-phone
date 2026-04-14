FROM node:20-slim

WORKDIR /app

# Install build dependencies for better-sqlite3 native module
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Install dependencies first (better caching)
COPY package*.json ./
RUN npm install --production

# Copy application code
COPY . .

# Create audio and data directories
RUN mkdir -p /app/audio /data

# HTTP API port
EXPOSE 3000
# WebSocket for audio streaming
EXPOSE 3001

CMD ["node", "index.js"]
