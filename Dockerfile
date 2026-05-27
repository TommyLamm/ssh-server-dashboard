FROM node:18-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++ gcc sqlite-dev
COPY package*.json ./
RUN npm ci --only=production

FROM node:18-alpine
WORKDIR /app
RUN apk add --no-cache openssh-client sqlite-libs
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY src/ ./src
COPY public/ ./public
EXPOSE 3000
ENV PORT=3000
ENV NODE_ENV=production
ENV DASHBOARD_DB_PATH=/app/data/dashboard.db
CMD ["npm", "start"]
