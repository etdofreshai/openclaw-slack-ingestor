FROM node:22-slim

WORKDIR /app

# Chromium runtime deps for CDP login flow (Debian-based, better compat)
RUN apt-get update && apt-get install -y --no-install-recommends \
  chromium \
  fonts-freefont-ttf \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY package*.json ./
RUN npm ci --omit=dev || npm ci

COPY . .

ENV NODE_ENV=production
ENV LOGIN_SERVER_PORT=3101

EXPOSE 3101

CMD ["npm", "run", "server"]
