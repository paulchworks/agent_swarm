import json
import logging
import threading
import uuid
from queue import Queue, Empty
from typing import List, Optional, Dict, Any, Generator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from strands import Agent
from strands.multiagent import Swarm

# ---------------- Logging (global) ----------------
STRANDS_LOGGER_NAME = "strands.multiagent"
logger = logging.getLogger(STRANDS_LOGGER_NAME)
logger.setLevel(logging.DEBUG)
logging.basicConfig(
    format="%(levelname)s | %(name)s | %(message)s",
    handlers=[logging.StreamHandler()]
)

# ---------------- FastAPI app ----------------
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "*"],  # tighten in prod
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health():
    return {"ok": True}

# ---------------- Models ----------------
class AgentSpec(BaseModel):
    name: str
    system_prompt: str = Field(default="You are a helpful specialist...")
    model: Optional[str] = None  # e.g., "gpt-4o", "anthropic/claude-3-5", or a Bedrock model id

class SwarmSettings(BaseModel):
    max_handoffs: int = 20
    max_iterations: int = 20
    execution_timeout: float = 900.0
    node_timeout: float = 300.0
    repetitive_handoff_detection_window: int = 8
    repetitive_handoff_min_unique_agents: int = 3
    entry_point: str  # name of the agent to start with

class RunRequest(BaseModel):
    task: str = Field(..., min_length=1, description="User-supplied task for the swarm")
    agents: List[AgentSpec]
    settings: SwarmSettings

class RunResponse(BaseModel):
    status: str
    node_history: List[str] = []
    output: Optional[Any] = None
    meta: Dict[str, Any] = {}

# ---------------- Build agents ----------------
def build_agents(agent_specs: List[AgentSpec]) -> Dict[str, Agent]:
    built: Dict[str, Agent] = {}
    for spec in agent_specs:
        kwargs = dict(name=spec.name, system_prompt=spec.system_prompt)
        if spec.model:
            kwargs["model"] = spec.model  # if your Strands build supports this
        built[spec.name] = Agent(**kwargs)
    return built

# ---------------- Non-streaming run (kept for compatibility) ----------------
@app.post("/api/run", response_model=RunResponse)
def run_swarm(req: RunRequest):
    if not req.task.strip():
        raise HTTPException(status_code=400, detail="task must not be empty")

    agents = build_agents(req.agents)
    try:
        entry = agents[req.settings.entry_point]
    except KeyError:
        raise HTTPException(status_code=400, detail=f"entry_point '{req.settings.entry_point}' not found in agents")

    swarm = Swarm(
        list(agents.values()),
        entry_point=entry,
        max_handoffs=req.settings.max_handoffs,
        max_iterations=req.settings.max_iterations,
        execution_timeout=req.settings.execution_timeout,
        node_timeout=req.settings.node_timeout,
        repetitive_handoff_detection_window=req.settings.repetitive_handoff_detection_window,
        repetitive_handoff_min_unique_agents=req.settings.repetitive_handoff_min_unique_agents
    )

    result = swarm(req.task.strip())

    status = getattr(result, "status", "unknown")
    node_history_objs = getattr(result, "node_history", [])
    node_ids = [getattr(n, "node_id", str(n)) for n in (node_history_objs or [])]

    output = None
    for key in ("output", "final_output", "result", "message", "content"):
        if hasattr(result, key):
            output = getattr(result, key)
            break

    meta: Dict[str, Any] = {}
    for k in ("metrics", "cost", "usage", "elapsed_time", "trace_id"):
        if hasattr(result, k):
            meta[k] = getattr(result, k)

    return RunResponse(status=status, node_history=node_ids, output=output, meta=meta)

# ================== STREAMING IMPLEMENTATION ==================

# Per-run context
class RunContext:
    def __init__(self):
        self.q: Queue[Dict[str, Any]] = Queue()
        self.done = threading.Event()
        self.summary: Optional[RunResponse] = None

# In-memory run store
RUNS: Dict[str, RunContext] = {}

# Logger handler that pushes log lines into a run queue
class QueueLogHandler(logging.Handler):
    def __init__(self, run_id: str, q: Queue[Dict[str, Any]]):
        super().__init__()
        self.run_id = run_id
        self.q = q

    def emit(self, record: logging.LogRecord):
        try:
            msg = self.format(record)
        except Exception:
            msg = record.getMessage()
        # Tag as 'log' event
        self.q.put({"type": "log", "run_id": self.run_id, "message": msg, "level": record.levelname})

def sse(event: str, data: Dict[str, Any]) -> bytes:
    """Format a Server-Sent Events message."""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8")

def run_worker(run_id: str, req: RunRequest):
    ctx = RUNS[run_id]
    q = ctx.q

    # Attach a temporary log handler
    h = QueueLogHandler(run_id, q)
    h.setLevel(logging.DEBUG)
    h.setFormatter(logging.Formatter("%(levelname)s | %(name)s | %(message)s"))
    logger.addHandler(h)

    # Emit start event
    q.put({"type": "start", "run_id": run_id, "task": req.task})

    try:
        agents = build_agents(req.agents)
        entry = agents[req.settings.entry_point]
        swarm = Swarm(
            list(agents.values()),
            entry_point=entry,
            max_handoffs=req.settings.max_handoffs,
            max_iterations=req.settings.max_iterations,
            execution_timeout=req.settings.execution_timeout,
            node_timeout=req.settings.node_timeout,
            repetitive_handoff_detection_window=req.settings.repetitive_handoff_detection_window,
            repetitive_handoff_min_unique_agents=req.settings.repetitive_handoff_min_unique_agents
        )

        # Execute
        result = swarm(req.task.strip())

        status = getattr(result, "status", "unknown")
        node_history_objs = getattr(result, "node_history", [])
        node_ids = [getattr(n, "node_id", str(n)) for n in (node_history_objs or [])]

        output = None
        for key in ("output", "final_output", "result", "message", "content"):
            if hasattr(result, key):
                output = getattr(result, key)
                break

        meta: Dict[str, Any] = {}
        for k in ("metrics", "cost", "usage", "elapsed_time", "trace_id"):
            if hasattr(result, k):
                meta[k] = getattr(result, k)

        summary = RunResponse(status=status, node_history=node_ids, output=output, meta=meta)
        ctx.summary = summary

        # Emit a final 'done' event carrying condensed summary
        q.put({
            "type": "done",
            "run_id": run_id,
            "status": status,
            "node_history": node_ids,
            "has_output": output is not None
        })
    except Exception as e:
        q.put({"type": "error", "run_id": run_id, "error": str(e)})
    finally:
        # Mark done and remove handler
        ctx.done.set()
        logger.removeHandler(h)

@app.post("/api/run/start")
def start_run(req: RunRequest):
    if not req.task.strip():
        raise HTTPException(status_code=400, detail="task must not be empty")

    run_id = uuid.uuid4().hex
    RUNS[run_id] = RunContext()

    # Background thread to run the swarm and push logs
    t = threading.Thread(target=run_worker, args=(run_id, req), daemon=True)
    t.start()

    return {"run_id": run_id}

@app.get("/api/result/{run_id}", response_model=RunResponse)
def get_result(run_id: str):
    ctx = RUNS.get(run_id)
    if not ctx:
        raise HTTPException(status_code=404, detail="run_id not found")
    if not ctx.done.is_set() or ctx.summary is None:
        # Return a 202 to indicate still running
        raise HTTPException(status_code=202, detail="still running")
    return ctx.summary

@app.get("/api/stream/{run_id}")
def stream_run(run_id: str):
    ctx = RUNS.get(run_id)
    if not ctx:
        raise HTTPException(status_code=404, detail="run_id not found")

    def gen() -> Generator[bytes, None, None]:
        # Let the client know the stream is ready
        yield sse("ready", {"run_id": run_id})
        while True:
            try:
                item = ctx.q.get(timeout=0.5)
                ev_type = item.pop("type", "log")
                yield sse(ev_type, item)
            except Empty:
                pass
            # Exit when done and queue drained
            if ctx.done.is_set() and ctx.q.empty():
                break
        # If we have a summary, emit it explicitly
        if ctx.summary:
            yield sse("summary", {
                "status": ctx.summary.status,
                "node_history": ctx.summary.node_history,
                "has_output": ctx.summary.output is not None
            })

    return StreamingResponse(gen(), media_type="text/event-stream")
