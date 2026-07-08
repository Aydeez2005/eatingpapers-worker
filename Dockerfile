FROM node:20-slim

# ca-certificates is required for curl to verify TLS when downloading yt-dlp
# (node:20-slim ships without it).
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 ffmpeg curl ca-certificates && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install all deps (incl. typescript) so the tsc build below can run.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

EXPOSE 3333

CMD ["node", "dist/index.js"]
