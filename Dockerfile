# Stage 1: Build static PWA client
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Production runtime with signaling server
FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

COPY package*.json ./
RUN npm ci --only=production

# Copy backend signaling script and built static assets
COPY server.js ./
COPY --from=builder /app/dist ./dist

EXPOSE 3001

CMD ["node", "server.js"]
