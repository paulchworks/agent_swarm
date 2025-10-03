# Strands Swarm Console

A minimal full-stack console for running **Strands** multi-agent swarms with a modern, console-first UI.

- **Backend:** FastAPI + Uvicorn  
- **Frontend:** React + Vite + Tailwind  
- **Streaming:** Server-Sent Events (SSE) for live traces and final results

---

## ✨ What’s New (UI)

- **Sticky Command Dock:** Task input + Run button stay visible while you scroll.
- **Console-first layout:** Tabs for **Trace / Transcript / Output** take center stage.
- **Compact Config:** Settings & Agents live in a collapsible sidebar.
- **Agent Transcript:** Final output can be parsed per-agent and rendered as readable blocks.

> No extra frontend deps — just React + Tailwind.

---

## 🧭 Architecture

```
/backend
  app.py         # FastAPI app: health, sync run, streaming start/stream/result
/frontend  (or /swarm-ui)
  src/App.tsx    # UI with sticky command dock, console tabs, compact config
```

**Key Endpoints**

- `GET /health` — health probe  
- `POST /api/run` — synchronous run (returns when the swarm completes)  
- `POST /api/run/start` — starts a run, returns `{ "run_id": "…" }`  
- `GET /api/stream/{run_id}` — **SSE** events: `ready`, `start`, `log`, `summary`, `done`  
- `GET /api/result/{run_id}` — final summary (returns **202** while running)

---

## ✅ Requirements

- **Python** 3.10+ (3.12 tested)
- **Node.js** **20.19+** or **22.12+** (required by Vite)
- `pip`, `uvicorn`, and the **Strands** Python package  
  (plus any LLM provider creds your agents need)

**Windows Node upgrade (nvm-windows):**

```powershell
choco install nvm
nvm install 22.12.0
nvm use 22.12.0
```

---

## ⚡ Quick Start (Development)

Open two terminals.

### 1) Backend

```bash
cd backend
python -m venv .venv
# macOS/Linux:
source .venv/bin/activate
# Windows:
# .venv\Scripts\activate

pip install -U pip
# Either:
pip install -r requirements.txt
# Or minimal:
# pip install fastapi uvicorn strands

uvicorn app:app --reload --port 8000
```

### 2) Frontend

```bash
cd frontend   # or: cd swarm-ui
npm install

# Point the UI to your backend:
# macOS/Linux:
export VITE_API_BASE="http://localhost:8000/"
# Windows PowerShell:
# $env:VITE_API_BASE="http://localhost:8000/"

npm run dev
```

Open **http://localhost:5173**.  
Enter a task in the sticky command dock and click **Run**.  
Watch **Trace** live; switch to **Transcript** / **Output** when complete.

---

## ⚙️ Configuration

### Environment Variables

**Frontend**

- `VITE_API_BASE` — absolute URL of the backend, e.g. `http://localhost:8000/`.  
  Omit or set to `/` if you proxy `/api` from the same origin in production.

**Backend / Strands**

- Set any provider keys your agents need (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or your Bedrock creds).

### CORS

`app.py` allows `http://localhost:5173` and `*` for development.  
**Tighten this for production.**

---

## 🛰️ API Details

### `POST /api/run` (synchronous)

```jsonc
// Request
{
  "task": "Build a REST API for a todo app",
  "agents": [
    { "name": "researcher", "system_prompt": "You are a research specialist..." },
    { "name": "architect",  "system_prompt": "You are an architecture specialist..." }
  ],
  "settings": {
    "max_handoffs": 20,
    "max_iterations": 20,
    "execution_timeout": 900,
    "node_timeout": 300,
    "repetitive_handoff_detection_window": 8,
    "repetitive_handoff_min_unique_agents": 3,
    "entry_point": "researcher"
  }
}
```

```jsonc
// Response (fields may vary by SDK version)
{
  "status": "COMPLETED",
  "node_history": ["researcher", "architect"],
  "output": null,
  "meta": { "elapsed_time": 41.75 },
  "transcript": [
    {
      "agent": "researcher",
      "role": "assistant",
      "text": "Handing off to architect…",
      "stop_reason": "end_turn",
      "usage": { "inputTokens": 1590, "outputTokens": 338, "totalTokens": 1928 }
    },
    {
      "agent": "architect",
      "role": "assistant",
      "text": "## Enterprise Architecture Roadmap ...",
      "stop_reason": "end_turn",
      "usage": { "inputTokens": 788, "outputTokens": 2231, "totalTokens": 3019 }
    }
  ]
}
```

> The backend serializes enums to strings for JSON/SSE compatibility.

### Streaming Flow

1. `POST /api/run/start` → `{ "run_id": "…" }`  
2. `GET /api/stream/{run_id}` → SSE events (`ready`, `start`, `log`, `summary`, `done`)  
3. `GET /api/result/{run_id}` → final summary (returns **202** while running)

SSE headers set in `app.py`:
- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`
- `X-Accel-Buffering: no` (for NGINX)

---

## 🏗️ Production Build & Deploy

### Build UI

```bash
cd frontend
npm run build
# Output in dist/
```

Serve `dist/` as static files and **proxy /api** to the FastAPI server.

### Example NGINX

```nginx
server {
  listen 80;
  server_name your.domain;

  root /var/www/swarm-ui/dist;
  index index.html;

  location / {
    try_files $uri $uri/ /index.html;
  }

  # Proxy API to FastAPI (Uvicorn/Gunicorn on 127.0.0.1:8000)
  location /api/ {
    proxy_pass http://127.0.0.1:8000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Connection "";
    proxy_set_header Upgrade $http_upgrade;

    # SSE
    proxy_buffering off;
    add_header Cache-Control no-cache;
  }

  location /health {
    proxy_pass http://127.0.0.1:8000/health;
  }
}
```

### Run Backend

```bash
pip install "uvicorn[standard]"
uvicorn app:app --host 127.0.0.1 --port 8000
```

> For hardening, consider Gunicorn + UvicornWorker, systemd units, TLS, and strict CORS.

---

## 🧪 Troubleshooting

- **`TypeError: Object of type Status is not JSON serializable`**  
  Fixed by casting enums to strings in `app.py` before JSON/SSE.

- **Vite error `crypto.hash is not a function`**  
  Use Node **20.19+** or **22.12+**.

- **SSE not updating through proxy**  
  Ensure `proxy_buffering off` on `/api/stream/*`.

- **CORS issues in dev**  
  Verify `VITE_API_BASE` and the `allow_origins` list in `app.py`.

---

## 🗒️ Changelog (recent)

- Sticky header command dock (non-scrolling Run/Task bar).
- Console-first layout with tabs and compact config.
- Agent transcript rendering support in the UI.
- Updated docs for Node version & SSE proxying.

---

## License

MIT (or your preferred license).
