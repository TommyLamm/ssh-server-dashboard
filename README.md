# SSH Multi-Server Linux Status Dashboard

Translations: [繁體中文](README.zh-TW.md)

---

A lightweight, self-hosted, agentless web dashboard to monitor the status and resource utilization of multiple Linux servers in real-time.

## Features
*   **Agentless Monitoring**: Monitor remote servers securely via SSH. No agent or extra software needs to be installed on target servers.
*   **Real-time Metrics**: Live stats for CPU usage, memory, disk I/O, network bandwidth, and system load.
*   **WebSockets**: Leverages WebSocket connections for instant UI updates.
*   **SQLite Storage**: Stores server list and connection details securely in a local SQLite database.
*   **Secure Authentication**: JWT-based secure login to protect your monitoring dashboard.
*   **Docker-Ready**: Deploy in seconds using a single `docker-compose.yml` file.
*   **GitHub Actions CI/CD**: Automatic Docker image compilation and publication to Docker Hub on every repository push.

---

## Deployment (Docker Compose)

To deploy the dashboard on your server, you only need a single `docker-compose.yml` file. 

Create a file named `docker-compose.yml` and paste the following content:

```yaml
version: '3.8'

services:
  dashboard:
    image: tommylam202/server-dashboard:latest
    container_name: server-dashboard
    ports:
      - "6688:6688"
    environment:
      - NODE_ENV=production
      - PORT=6688
      - DASHBOARD_USERNAME=admin                 # Web portal login username
      - DASHBOARD_PASSWORD=your_password         # Web portal login password
      - DASHBOARD_SECRET=your_jwt_secret_key     # Secure key for JWT signing (random string)
      - ENCRYPTION_KEY=your_64_char_hex_key      # Must be a 64-character hex string (0-9, a-f) for SSH credential encryption
    volumes:
      - dashboard-data:/app/data
    restart: unless-stopped

volumes:
  dashboard-data:
```

### Run the Container
Start the dashboard by running:
```bash
docker compose up -d
```
Access the dashboard in your web browser at `http://your-server-ip:6688`.

---

## Environment Variables

| Variable | Description | Example |
| :--- | :--- | :--- |
| `DASHBOARD_USERNAME` | Web dashboard login username. | `admin` |
| `DASHBOARD_PASSWORD` | Web dashboard login password. | `my_secure_password` |
| `DASHBOARD_SECRET` | Secret key used to sign JWT authentication tokens. | `some-random-secret-key-123!` |
| `ENCRYPTION_KEY` | Hex string (length 64) for AES-256 encryption of SSH credentials. | `7a4d378881f5804c22ba9270e7fb73ce31f4335ec54537cbf8910617305c21e7` |

> [!WARNING]
> Ensure you change the default values of `DASHBOARD_PASSWORD`, `DASHBOARD_SECRET`, and `ENCRYPTION_KEY` before running the container in production.
