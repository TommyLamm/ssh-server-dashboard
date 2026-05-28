# SSH 多伺服器 Linux 狀態監控面板 (SSH Multi-Server Linux Status Dashboard)

其他語言：[English](README.md)

---

一個輕量、自託管、免安裝 Agent 的 Linux 多伺服器狀態即時監控面板。

## 功能特點
*   **免安裝 Agent (無代理監控)**：透過 SSH 安全地連線並監控遠端伺服器，目標伺服器無需安裝任何額外軟體。
*   **即時數據指標**：即時呈現 CPU 使用率、記憶體、硬碟 I/O、網路頻寬及系統負載。
*   **即時推播**：利用 WebSocket 技術，實現毫秒級的前端數據更新。
*   **SQLite 儲存**：安全地在本地 SQLite 資料庫中存儲伺服器列表與連線資訊。
*   **安全身分驗證**：基於 JWT 的安全登入機制，防止未授權的存取。
*   **Docker 部署**：只需單個 `docker-compose.yml` 即可在數秒內完成部署。
*   **GitHub Actions 自動化**：程式碼推送到倉庫時，自動於雲端建置並發佈映像檔到 Docker Hub。

---

## 部署方法 (Docker Compose)

在您的服務器上部署此面板，您只需要一個 `docker-compose.yml` 檔案。

創建名為 `docker-compose.yml` 的檔案並寫入以下內容：

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
      - DASHBOARD_USERNAME=admin                 # 網頁登入帳號
      - DASHBOARD_PASSWORD=您的安全密碼             # 網頁登入密碼
      - DASHBOARD_SECRET=您的隨機安全金鑰           # JWT 簽章安全密鑰（可隨意輸入長字串）
      - ENCRYPTION_KEY=您的64位元Hex加密金鑰         # 必須是 64 個字元的十六進位字串（0-9, a-f），用於加密 SSH 連線憑證
    volumes:
      - dashboard-data:/app/data
    restart: unless-stopped

volumes:
  dashboard-data:
```

### 啟動服務
在該目錄下執行以下指令啟動容器：
```bash
docker compose up -d
```
啟動後，使用瀏覽器訪問 `http://您的服務器IP:6688` 即可進入面板。

---

## 環境變數說明

| 變數名稱 | 說明 | 範例 |
| :--- | :--- | :--- |
| `DASHBOARD_USERNAME` | 面板的登入使用者名稱。 | `admin` |
| `DASHBOARD_PASSWORD` | 面板的登入密碼。 | `my_secure_password` |
| `DASHBOARD_SECRET` | 用於簽署 JWT 身分驗證 Token 的安全密鑰。 | `some-random-secret-key-123!` |
| `ENCRYPTION_KEY` | 64 位元的 Hex 加密金鑰，用於 AES-256 加密存儲 SSH 連線憑證。 | `7a4d378881f5804c22ba9270e7fb73ce31f4335ec54537cbf8910617305c21e7` |

> [!WARNING]
> 在正式環境（Production）部署前，請務必更換 `DASHBOARD_PASSWORD`、`DASHBOARD_SECRET` 與 `ENCRYPTION_KEY` 的預設值以確保安全。
