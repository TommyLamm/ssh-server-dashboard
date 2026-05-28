# Multi-Server Linux Status Dashboard (Dockerized) - Design Spec

**Date:** 2026-05-28  
**Status:** Approved  
**Author:** Antigravity  

---

## 1. Goal & Context
The goal is to create a web-based dashboard running inside a Docker container that monitors multiple remote Linux servers. The user can dynamically add, edit, and delete servers in the UI. For each active server, the dashboard establishes secure SSH connections to stream real-time metrics (CPU, Memory, Disk Space, Disk I/O, Network traffic, Processes, Docker Containers, and Logs) to the frontend.

## 2. Architectural Overview

### 2.1 Backend (Node.js & Express)
- **Express Server:** Handles static UI assets, Auth APIs, and Server Connection management REST APIs.
- **WebSockets (`express-ws`):** Provides a bi-directional real-time connection between the browser and backend. When a client opens a server's dashboard tab, a WebSocket connection is established.
- **SSH Connection Pool (`ssh2`):** Manages SSH connections. Each monitored server has an associated runner in the pool. When a client views a server, a background loop runs monitoring commands over SSH every 2 seconds and pushes the parsed JSON output to the client. When the client closes the tab, the SSH session is paused/cleaned up to prevent resource waste.
- **Database (SQLite & `better-sqlite3` or `sqlite3`):** Stores the user settings, server metadata (IP, port, username), and encrypted credentials.

### 2.2 Frontend (HTML5 / Vanilla JS / Vanilla CSS)
- **Layout:** Master-Detail design. Collapsible left sidebar for the server list (with status indicator green/red and live resource miniature sparklines). Main detail pane with tabs for:
  - **Overview:** Gauge charts (CPU, Memory, Disk) and historical line sparklines.
  - **Processes:** Interactive process list (PID, User, CPU%, Mem%, Command) with sort controls.
  - **Docker:** Remote container list (Name, Status, CPU%, Mem%) with quick controls.
  - **Logs:** Live log viewer for systemd services or custom file paths.
- **Styling:** Premium dark-theme using HSL colors, smooth transitions, custom CSS variables, and responsive design adapting seamlessly to mobile (sidebar transforms into a slide-over drawer).

### 2.3 Containerization (Docker)
- A Dockerfile compiles and exposes the web app on port `3000`.
- The SQLite database is saved under `/app/data/dashboard.db` which is mapped to a persistent volume.

---

## 3. Data Flow & SSH Parser Commands

When a server is selected, the backend runs commands via SSH and parses their stdout:

1. **System Info & Uptime:**
   - Command: `uname -sr && uptime -p && hostname`
2. **CPU Metrics:**
   - Command: `top -bn1 | grep "Cpu(s)"` (Parses user, system, idle CPU percentages)
   - Alternative/Addition: `/proc/loadavg` for load averages.
3. **Memory Metrics:**
   - Command: `free -b` (Parses total, used, free, cache, and swap memory in bytes)
4. **Disk Space:**
   - Command: `df -h --output=source,fstype,size,used,avail,pcent,target -x tmpfs -x devtmpfs`
5. **Disk I/O:**
   - Command: `cat /proc/diskstats` or `iostat -d 1 2` (Reads sectors read/written to calculate MB/s transfer speed)
6. **Network Traffic:**
   - Command: `cat /proc/net/dev` (Reads bytes received/transmitted per interface, diffed over intervals to compute speed)
7. **Process List:**
   - Command: `ps -eo pid,user,%cpu,%mem,comm --sort=-%cpu | head -n 30`
8. **Docker Status:**
   - Command: `docker stats --no-stream --format '{"container":"{{.Name}}","cpu":"{{.CPUPerc}}","mem":"{{.MemUsage}}","status":"running"}'` merged with `docker ps -a --format '{"container":"{{.Names}}","status":"{{.Status}}"}'`
9. **Logs Viewer:**
   - Command: `journalctl -u <service_name> -n 100 --no-pager` or `tail -n 100 <file_path>`

---

## 4. Security Model

1. **Dashboard Access Authentication:**
   - Accessing the dashboard UI requires entering a username and password.
   - Credentials are set via environment variables `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD` (defaulting to `admin`/`admin`).
   - Successful login generates a session cookie or JWT token.
2. **Server Credential Storage Encryption:**
   - SSH private keys and passwords stored in the SQLite database are encrypted using **AES-256-GCM**.
   - The encryption key is derived from a `DASHBOARD_SECRET` environment variable. If not set, it is dynamically generated at startup and written to a secure file.
3. **Execution Safety:**
   - The backend never runs free-form input shell commands. Arguments like container names, service names, and log file paths are strictly sanitized to prevent shell injection (e.g. escaping special shell characters).

---

## 5. Verification Plan

### 5.1 Automated Testing
- Unit tests for SSH command parsers (ensuring outputs from various Linux distros are correctly mapped).
- Unit tests for DB encryption/decryption routines.

### 5.2 Manual Verification
- Deploying the app locally using `docker compose up --build`.
- Connecting to a test Linux server (e.g., localhost or virtual machine) and verifying live data rendering.
- Resizing browser to test mobile-responsiveness.
