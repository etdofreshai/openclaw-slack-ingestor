FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm ci

COPY . .

ENV NODE_ENV=production
ENV PORT=3101

EXPOSE 3101

CMD ["npm", "run", "server"]
