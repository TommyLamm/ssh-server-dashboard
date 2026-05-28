# Port 6666 Change Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the dashboard container to listen on and expose port 6666 because port 3000 is already in use.

**Architecture:** Update Docker Compose to map host and container port 6666 and set the runtime `PORT`. Align Dockerfile `EXPOSE` with the runtime port for clarity.

**Tech Stack:** Docker, Docker Compose, Node.js

---

## File Map
- docker-compose.yml: Container runtime config, port mapping, and environment variables.
- Dockerfile: Container image metadata (exposed port) and runtime entrypoint.

### Task 1: Update Docker Compose port mapping

**Files:**
- Modify: docker-compose.yml

- [ ] **Step 1: Edit docker-compose.yml to use port 6666**

```yaml
version: '3.8'

services:
  dashboard:
    build: .
    image: server-dashboard:latest
    container_name: server-dashboard
    ports:
      - "6666:6666"
    environment:
      - PORT=6666
      - DASHBOARD_USERNAME=${DASHBOARD_USERNAME:-admin}
      - DASHBOARD_PASSWORD=${DASHBOARD_PASSWORD:-admin}
      - DASHBOARD_SECRET=${DASHBOARD_SECRET:-SuperSecretKeyForJWTAuth123!}
      - ENCRYPTION_KEY=${ENCRYPTION_KEY:-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef}
    volumes:
      - dashboard-data:/app/data
    restart: unless-stopped

volumes:
  dashboard-data:
```

- [ ] **Step 2: Validate the compose config**

Run: `docker compose config`

Expected (snippet):
```yaml
services:
  dashboard:
    ports:
      - 6666:6666
    environment:
      PORT: "6666"
```

- [ ] **Step 3: Commit the compose change**

```bash
git add docker-compose.yml
git commit -m "chore: map dashboard to port 6666"
```

### Task 2: Update Dockerfile exposed port

**Files:**
- Modify: Dockerfile

- [ ] **Step 1: Edit Dockerfile to expose 6666**

```dockerfile
FROM node:18-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++ gcc sqlite-dev
RUN chown -R node:node /app
USER node
COPY --chown=node:node package*.json ./
RUN npm ci --only=production

FROM node:18-alpine
WORKDIR /app
RUN apk add --no-cache openssh-client sqlite-libs
RUN mkdir -p /app/data && chown -R node:node /app
USER node
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node package*.json ./
COPY --chown=node:node src/ ./src
COPY --chown=node:node public/ ./public
EXPOSE 6666
ENV PORT=3000
ENV NODE_ENV=production
ENV DASHBOARD_DB_PATH=/app/data/dashboard.db
CMD ["node", "src/server.js"]
```

- [ ] **Step 2: Build the image to validate the Dockerfile**

Run: `docker build -t server-dashboard:port-6666 .`

Expected (snippet):
```
Successfully built <image-id>
Successfully tagged server-dashboard:port-6666
```

- [ ] **Step 3: Commit the Dockerfile change**

```bash
git add Dockerfile
git commit -m "chore: expose port 6666"
```

### Task 3: Runtime verification

**Files:**
- Modify: none

- [ ] **Step 1: Rebuild and start the service**

Run: `docker compose up -d --build`

Expected: container starts without errors.

- [ ] **Step 2: Confirm the port mapping**

Run: `docker compose ps`

Expected (snippet):
```
server-dashboard  ...  0.0.0.0:6666->6666/tcp
```

- [ ] **Step 3: Verify the UI loads**

Open: `http://localhost:6666`

Expected: login page loads successfully.
