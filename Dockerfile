FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++ gcc sqlite-dev
RUN chown -R node:node /app
USER node
COPY --chown=node:node package*.json ./
RUN npm ci --only=production

FROM node:22-alpine
WORKDIR /app
RUN apk update && apk upgrade --no-cache && apk add --no-cache openssh-client sqlite-libs wget
RUN npm install -g npm@latest
RUN mkdir -p /app/data && chown -R node:node /app
USER node
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node package*.json ./
COPY --chown=node:node src/ ./src
COPY --chown=node:node public/ ./public
EXPOSE 6688
ENV PORT=6688
ENV NODE_ENV=production
ENV DASHBOARD_DB_PATH=/app/data/dashboard.db
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/health || exit 1
CMD ["node", "src/server.js"]
