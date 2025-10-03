# Strands Swarm Console 

<img width="1889" height="796" alt="image" src="https://github.com/user-attachments/assets/b0c789e8-6b51-4b60-9ebc-79fad4bf474a" />

FastAPI + React (Vite + Tailwind) with **live agent traces (SSE)**

A small full-stack project that wraps your working Strands multi-agent code behind a FastAPI API and adds a modern React UI to:

- configure agents & swarm settings,
- **enter a task** (required),
- run the workflow,
- watch **live traces** (agent handoffs/logs via Server-Sent Events),
- view the **final output** and metadata.

---

## ✨ Features

- **No auto-run**: waits for a user-entered **Task**.
- **Live traces** via SSE: `/api/run/start` → `/api/stream/{run_id}` → `/api/result/{run_id}`.
- Simple **health check**: `GET /health`.
- Clean, responsive **Tailwind UI** (no UI libs).
- Dev-friendly: **Vite proxy** → no CORS headaches locally.

---

## 🧭 Project Structure

```
repo/
├─ backend/
│  ├─ app.py               # FastAPI app + SSE
│  └─ requirements.txt     # fastapi, uvicorn, strands-agents, etc.
└─ swarm-ui/
   ├─ src/
   │  ├─ App.tsx           # React UI (with Live Trace + Status/Output)
   │  └─ main.tsx          # imports ./index.css
   ├─ index.html
   ├─ tailwind.config.js
   ├─ postcss.config.js
   ├─ vite.config.ts       # proxy /api, /health → backend:8000
   ├─ package.json
   └─ src/index.css        # @tailwind base/components/utilities
```

---

## ⚙️ Prerequisites

- **Python** 3.10+ (3.12 recommended)
- **Node.js** 22.12+ (or 20.19+) and **npm**
- Your LLM credentials (as applicable). Examples:
  - `OPENAI_API_KEY`
  - `ANTHROPIC_API_KEY`
  - AWS credentials if using **Bedrock**

> On Windows, Node version management is easiest with **nvm-windows** (Corey Butler).  
> Or install Node 22.x MSI from nodejs.org.

---

## 🚀 Local Development

### 1) Backend

```powershell
cd backend
python -m venv .venv
# Windows:
. .venv/Scripts/activate
# macOS/Linux:
# source .venv/bin/activate

pip install -U pip
pip install -r requirements.txt

# (optional) set your model API env vars, e.g.:
# $env:OPENAI_API_KEY="sk-..."         # PowerShell
# export OPENAI_API_KEY="sk-..."       # macOS/Linux

# Start API (port 8000)
uvicorn app:app --reload --host 0.0.0.0 --port 8000
```

Sanity check:
```powershell
curl http://127.0.0.1:8000/health   # -> {"ok": true}
```

### 2) Frontend

```powershell
cd swarm-ui
npm install

# Dev server (port 5173)
npm run dev
```

Open the printed URL (typically `http://localhost:5173`).  
The UI talks to the backend through the **Vite proxy** defined in `vite.config.ts`.

> If you prefer not to use the proxy, set `swarm-ui/.env`:
> 
> ```
> VITE_API_BASE=http://127.0.0.1:8000/
> ```
> 
> and the app will call the backend directly (ensure CORS allows your origin).

---

## 🧪 How It Works

### Backend API (high-level)

- `POST /api/run`  
  Traditional one-shot run (no streaming). Kept for compatibility.

- `POST /api/run/start` → `{ run_id }`  
  Starts a run in a background thread and attaches a **log handler** to `strands.multiagent`.

- `GET /api/stream/{run_id}` (SSE)  
  Streams events: `ready`, `start`, `log`, `error`, `done`, `summary`.

- `GET /api/result/{run_id}`  
  Returns final `{status, node_history, output, meta}` once complete.  
  Returns **202** while still running.

- `GET /health`  
  `{ ok: true }`

### Frontend Flow

1. **Enter Task** → click **Run Swarm**  
2. UI calls `POST /api/run/start` → saves `run_id`  
3. UI opens `EventSource(/api/stream/{run_id})` and renders **Live Trace**  
4. On `done`, UI fetches `/api/result/{run_id}` and fills **Status & Output**

---

## 🏗️ Production Build

### Build the React app

```powershell
cd swarm-ui
npm run build
# outputs: swarm-ui/dist/
```

You can test locally:
```powershell
npm run preview
```

### Serve the frontend + backend

**Option A: Nginx (static UI + proxy /api)**

1) Copy `swarm-ui/dist/` to your web server host (e.g., `/var/www/swarm-ui`).

2) Run backend (behind systemd, Docker, or a process manager). Example (bare):
```bash
# inside backend venv on server
uvicorn app:app --host 0.0.0.0 --port 8000 --workers 2
```

3) Nginx site (SSE friendly):

```nginx
server {
  listen 80;
  server_name your-domain.tld;

  # Serve static frontend
  root /var/www/swarm-ui;
  index index.html;

  # API proxy (FastAPI)
  location /api/ {
    proxy_pass         http://127.0.0.1:8000;
    proxy_http_version 1.1;
    proxy_set_header   Connection "";
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_read_timeout 3600;
    proxy_send_timeout 3600;
    proxy_buffering    off;     # important for SSE
    add_header         Cache-Control no-cache;
  }

  # Health route (optional)
  location /health {
    proxy_pass http://127.0.0.1:8000/health;
  }

  # SPA fallback for client-side routing
  location / {
    try_files $uri /index.html;
  }
}
```

**Option B: Docker (example)**

_Quick single-host example; adapt to your registry and base images._

`backend/Dockerfile`:
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend /app
ENV PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
```

`swarm-ui/Dockerfile`:
```dockerfile
# build stage
FROM node:22-alpine AS build
WORKDIR /ui
COPY swarm-ui/package*.json ./
RUN npm ci
COPY swarm-ui .
RUN npm run build

# serve stage
FROM nginx:alpine
COPY --from=build /ui/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

`nginx.conf` (same proxy rules as above).

`docker-compose.yml` (optional):
```yaml
version: "3.9"
services:
  api:
    build: ./backend
    ports: ["8000:8000"]
    environment:
      # pass your LLM creds here or via secrets
      # OPENAI_API_KEY: ${OPENAI_API_KEY}
    restart: unless-stopped
  web:
    build: ./swarm-ui
    ports: ["80:80"]
    depends_on: [api]
    restart: unless-stopped
```

---

## 🔐 Environment & Models

- The backend creates `Agent` objects from the UI specs. If your `strands` build supports a `model` parameter, type it per agent (e.g., `\"gpt-4o\"`, `\"anthropic/claude-3-5\"`, a Bedrock model id).  
- If you skip `model`, Strands uses its **default backend** (e.g., from `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, AWS creds).

Set environment variables before launching Uvicorn (examples):

**PowerShell**
```powershell
$env:OPENAI_API_KEY="sk-..."
# $env:ANTHROPIC_API_KEY="..."
# $env:AWS_ACCESS_KEY_ID="..."; $env:AWS_SECRET_ACCESS_KEY="..."
```

**bash/zsh**
```bash
export OPENAI_API_KEY="sk-..."
# export ANTHROPIC_API_KEY="..."
# export AWS_ACCESS_KEY_ID="..."; export AWS_SECRET_ACCESS_KEY="..."
```

---

## 🩺 Troubleshooting

- **Vite proxy “ECONNREFUSED ::1:8000”**  
  Your proxy used IPv6 (`::1`) while Uvicorn listened on IPv4.  
  Fix: in `vite.config.ts` set proxy target to `http://127.0.0.1:8000`, or start Uvicorn with `--host ::`.

- **Vite “crypto.hash is not a function”**  
  Node version too old. Use Node **22.12+** (or 20.19+), reinstall `node_modules`.

- **Tailwind styles not showing**  
  Ensure `src/main.tsx` imports `\"./index.css\"` and your `index.css` begins with:
  ```css
  @tailwind base;
  @tailwind components;
  @tailwind utilities;
  ```
  Also confirm `tailwind.config.js` scans `./src/**/*.{js,ts,jsx,tsx}`.

- **Tailwind 4 PostCSS error**  
  Install the plugin and update PostCSS config:
  ```bash
  npm i -D @tailwindcss/postcss postcss autoprefixer
  ```
  `postcss.config.js`:
  ```js
  export default { plugins: { \"@tailwindcss/postcss\": {}, autoprefixer: {} } }
  ```

- **CORS**  
  In `app.py`:
  ```python
  allow_origins=[\"http://localhost:5173\",\"http://127.0.0.1:5173\"]
  ```
  Or rely on the Vite proxy (`/api` → backend) in dev to avoid CORS entirely.

- **SSE behind proxies**  
  Disable buffering and keep HTTP/1.1:
  ```nginx
  proxy_http_version 1.1;
  proxy_buffering off;
  add_header Cache-Control no-cache;
  ```

---

## 🧼 Quality of Life

- “Run ID” label (shortened) appears while a run is active.
- **Clear** button in **Live Trace** resets the panel.
- Output boxes use `whitespace-pre-wrap` + `overflow-auto`.
- Mobile/desktop responsive: grids scale `1 → 2 → 3` columns; right column becomes sticky on large screens.

---

## 📦 Commands Summary

**Backend**
```bash
# setup
python -m venv .venv
source .venv/bin/activate        # or . .venv/Scripts/activate on Windows
pip install -U pip
pip install -r requirements.txt

# run
uvicorn app:app --reload --host 0.0.0.0 --port 8000
```

**Frontend**
```bash
npm install
npm run dev         # dev server with proxy
npm run build       # production build (swarm-ui/dist/)
npm run preview     # static preview of built assets
```

---

## ✅ What to Expect

1. Open the UI → enter a **Task**.
2. Click **Run Swarm**.
3. Watch **Live Trace** fill with logs/hand-offs.
4. When done, see **Status & Output** with final result and node history.
