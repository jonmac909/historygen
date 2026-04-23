FROM node:20-slim

# System dependencies
RUN apt-get update && apt-get install -y \
    fontconfig \
    fonts-dejavu-core \
    fonts-liberation \
    libvips-dev \
    ffmpeg \
    curl \
    python3 \
    tmux \
    supervisor \
    procps \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp binary
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp
RUN yt-dlp --version

# Claude Code CLI — pinned so silent auto-updates can't break builds.
RUN npm install -g @anthropic-ai/claude-code@2.1.112
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_USE_BEDROCK=0 \
    CLAUDE_CODE_WORKDIR=/tmp/claude-bridge/workdir \
    BRIDGE_TMP_DIR=/tmp/claude-bridge \
    BRIDGE_TMP_BUDGET=104857600

WORKDIR /app

# Install render-api deps.
COPY package*.json ./
RUN npm ci

# Install claude-bridge deps.
COPY claude-bridge/package*.json ./claude-bridge/
RUN cd claude-bridge && npm ci

# Copy source + build both.
COPY . .
RUN npm run build
RUN cd claude-bridge && npm run build

# Supervisord + entrypoint.
COPY supervisord.conf /etc/supervisor/conf.d/app.conf
RUN chmod +x entrypoint.sh

# Neutral workdir for the CLI (no CLAUDE.md auto-discovery).
RUN mkdir -p /tmp/claude-bridge/workdir

EXPOSE 10000

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["supervisord", "-n", "-c", "/etc/supervisor/conf.d/app.conf"]
