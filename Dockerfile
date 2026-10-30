FROM node:22-slim

# Baileys pulls one dependency (libsignal) from a git URL, so git and
# ca-certificates must be present at install time (same as the DealsPulse bot).
# ffmpeg converts videos for WhatsApp and measures photos/videos (media.js).
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["node", "server.js"]
