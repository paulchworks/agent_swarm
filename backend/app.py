import json
import logging
import threading
import uuid
from queue import Queue, Empty
from typing import List, Optional, Dict, Any, Generator, Tuple
from enum import Enum
from collections import deque
import datetime

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
    # note: allow_credentials=True + "*" is not ideal; tighten in prod
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "*"],
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

class AgentTurn(BaseModel):
    agent: str
    role: Optional[str] = None
    text: str = ""
    stop_reason: Optional[str] = None
    usage: Optional[Dict[str, Any]] = None
    metrics: Optional[Dict[str, Any]] = None

class RunResponse(BaseModel):
    status: str
    node_history: List[str] = []
    output: Optional[Any] = None
    meta: Dict[str, Any] = {}
    transcript: List[AgentTurn] = []  # NEW: per-agent blocks in node order

# ---------------- Build agents ----------------
def build_agents(agent_specs: List[AgentSpec]) -> Dict[str, Agent]:
    built: Dict[str, Agent] = {}
    for spec in agent_specs:
        kwargs = dict(name=spec.name, system_prompt=spec.system_prompt)
        if spec.model:
            kwargs["model"] = spec.model  # if your Strands build supports this
        built[spec.name] = Agent(**kwargs)
    return built

# ================== helpers: json-safe SSE + extraction ==================
def sse(event: str, data: Dict[str, Any]) -> bytes:
    def _default(o):
        if isinstance(o, Enum):
            return getattr(o, "name", str(o))
        if isinstance(o, (datetime.datetime, datetime.date)):
            return o.isoformat()
        if isinstance(o, set):
            return list(o)
        if isinstance(o, (bytes, bytearray)):
            try:
                return o.decode("utf-8", "ignore")
            except Exception:
                return str(o)
        return str(o)
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, default=_default)}\n\n".encode("utf-8")

CANDIDATE_FIELDS = (
    "output", "final_output", "result", "message", "content",
    "text", "response", "final", "answer", "data", "value",
)

def extract_output_like(obj: Any) -> Any:
    if obj is None:
        return None
    for k in CANDIDATE_FIELDS:
        if hasattr(obj, k):
            v = getattr(obj, k)
            if v is not None:
                return v
    if isinstance(obj, dict):
        for k in CANDIDATE_FIELDS:
            if k in obj and obj[k] is not None:
                return obj[k]
    for method in ("model_dump", "dict", "to_dict"):
        if hasattr(obj, method):
            try:
                d = getattr(obj, method)()
                return extract_output_like(d)
            except Exception:
                pass
    if isinstance(obj, (list, tuple)) and obj:
        return extract_output_like(obj[-1])
    if isinstance(obj, (bytes, bytearray)):
        try:
            return obj.decode("utf-8", "ignore")
        except Exception:
            pass
    s = str(obj)
    if s and not s.startswith("<"):
        return s
    return None

def to_dict_safe(o: Any) -> Optional[Dict[str, Any]]:
    if o is None:
        return None
    if isinstance(o, dict):
        return o
    for m in ("model_dump", "dict", "to_dict"):
        if hasattr(o, m):
            try:
                return getattr(o, m)()
            except Exception:
                pass
    return None

def get_content_text(message: Any) -> Tuple[Optional[str], Optional[str]]:
    """
    Returns (role, text) from a strands AgentResult.message which is often:
      {"role": "assistant", "content": [{"text": "..."}, ...]}
    Falls back gracefully if formats vary.
    """
    md = to_dict_safe(message)
    if not md:
        # string fallback
        if isinstance(message, str):
            return (None, message)
        return (None, None)

    role = md.get("role")
    content = md.get("content")

    # content can be list[{"text": ...}, ...] or a string
    if isinstance(content, list):
        parts = []
        for c in content:
            if isinstance(c, dict) and "text" in c and c["text"]:
                parts.append(str(c["text"]))
            elif isinstance(c, str):
                parts.append(c)
        return (role, "\n".join(parts).strip() if parts else None)
    if isinstance(content, str):
        return (role, content)
    # sometimes message directly has a 'text'
    if "text" in md and isinstance(md["text"], str):
        return (role, md["text"])
    return (role, None)

def extract_transcript(result: Any) -> List[AgentTurn]:
    """
    Build a list of AgentTurn in the order of node_history (if present).
    """
    transcript: List[AgentTurn] = []

    # gather node order
    node_order: List[str] = []
    node_hist = getattr(result, "node_history", None)
    if node_hist and isinstance(node_hist, (list, tuple)):
        for n in node_hist:
            node_order.append(getattr(n, "node_id", str(n)))

    # get results mapping
    results_map = getattr(result, "results", None)
    if results_map is None and isinstance(result, dict):
        results_map = result.get("results")

    if isinstance(results_map, dict) and results_map:
        # order by node_history first; then append any leftovers
        seen = set()
        ordered_agents = [a for a in node_order if a in results_map]
        for a in ordered_agents:
            seen.add(a)
        for a in results_map.keys():
            if a not in seen:
                ordered_agents.append(a)

        for agent in ordered_agents:
            node = results_map.get(agent)
            # node may be NodeResult or dict-like
            node_dict = to_dict_safe(node) or {}
            agent_result = node_dict.get("result", None) or getattr(node, "result", None)

            stop_reason = getattr(agent_result, "stop_reason", None)
            usage = (
                getattr(node, "accumulated_usage", None)
                or getattr(agent_result, "accumulated_usage", None)
                or to_dict_safe(node_dict.get("accumulated_usage"))
            )

            # metrics (keep compact)
            metrics = (
                getattr(agent_result, "metrics", None)
                or node_dict.get("accumulated_metrics")
                or getattr(node, "accumulated_metrics", None)
            )
            metrics = to_dict_safe(metrics)

            role, text = (None, None)
            if hasattr(agent_result, "message") or (isinstance(agent_result, dict) and "message" in agent_result):
                msg = getattr(agent_result, "message", None) or (agent_result.get("message") if isinstance(agent_result, dict) else None)
                role, text = get_content_text(msg)

            if text is None:
                # try generic extraction from agent_result
                text = extract_output_like(agent_result)
                if isinstance(text, dict):
                    # avoid dumping large dicts; stringify compactly
                    text = json.dumps(text, ensure_ascii=False)[:4000]

            transcript.append(AgentTurn(
                agent=agent,
                role=role,
                text=(text or "").strip(),
                stop_reason=stop_reason,
                usage=to_dict_safe(usage),
                metrics=metrics,
            ))

    return transcript

# ================== STREAMING IMPLEMENTATION ==================

# Per-run context
class RunContext:
    def __init__(self):
        self.q: Queue[Dict[str, Any]] = Queue()
        self.done = threading.Event()
        self.summary: Optional[RunResponse] = None
        self.logs = deque(maxlen=1000)  # keep a tail of logs for debugging

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
        # keep a small tail in memory for meta/debug
        ctx = RUNS.get(self.run_id)
        if ctx:
            ctx.logs.append(msg)

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

    # ---- cast status to a plain string ----
    status_raw = getattr(result, "status", "unknown")
    status = status_raw.name if isinstance(status_raw, Enum) else str(status_raw)

    node_history_objs = getattr(result, "node_history", [])
    node_ids = [getattr(n, "node_id", str(n)) for n in (node_history_objs or [])]

    # robust output extraction
    output = extract_output_like(result)

    # transcript (per-agent text)
    transcript = extract_transcript(result)

    # if output missing, fallback to last agent's text
    if output is None and transcript:
        output = transcript[-1].text

    meta: Dict[str, Any] = {"agent_count": len(transcript)}
    for k in ("metrics", "cost", "usage", "elapsed_time", "trace_id"):
        if hasattr(result, k):
            meta[k] = getattr(result, k)
    if output is None:
        meta["note"] = "No final output detected on result; consider making the final agent return plain text."

    return RunResponse(status=status, node_history=node_ids, output=output, meta=meta, transcript=transcript)

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

        # ---- cast status to a plain string ----
        status_raw = getattr(result, "status", "unknown")
        status = status_raw.name if isinstance(status_raw, Enum) else str(status_raw)

        node_history_objs = getattr(result, "node_history", [])
        node_ids = [getattr(n, "node_id", str(n)) for n in (node_history_objs or [])]

        # robust output + transcript
        output = extract_output_like(result)
        transcript = extract_transcript(result)
        if output is None and transcript:
            output = transcript[-1].text

        meta: Dict[str, Any] = {"agent_count": len(transcript)}
        for k in ("metrics", "cost", "usage", "elapsed_time", "trace_id"):
            if hasattr(result, k):
                meta[k] = getattr(result, k)
        if output is None and ctx.logs:
            meta["logs_tail"] = list(ctx.logs)[-50:]
            meta["note"] = (
                "Swarm completed but produced no final output. "
                "Consider prompting the final agent to 'return the final answer as plain text'."
            )

        summary = RunResponse(status=status, node_history=node_ids, output=output, meta=meta, transcript=transcript)
        ctx.summary = summary

        # Emit a final 'done' event carrying condensed summary + small previews
        output_prev = (output[:300] if isinstance(output, str) else None)
        tx_prev = [
            {"agent": t.agent, "preview": (t.text[:180] if t.text else "")}
            for t in (transcript[-4:] if transcript else [])
        ]
        q.put({
            "type": "done",
            "run_id": run_id,
            "status": status,
            "node_history": node_ids,
            "has_output": output is not None,
            "output_preview": output_prev,
            "transcript_preview": tx_prev,
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
            output_prev = (ctx.summary.output[:300] if isinstance(ctx.summary.output, str) else None)
            tx_prev = [
                {"agent": t.agent, "preview": (t.text[:180] if t.text else "")}
                for t in (ctx.summary.transcript[-4:] if ctx.summary.transcript else [])
            ]
            yield sse("summary", {
                "status": ctx.summary.status,
                "node_history": ctx.summary.node_history,
                "has_output": ctx.summary.output is not None,
                "output_preview": output_prev,
                "transcript_preview": tx_prev,
            })

    # Helpful SSE headers for proxies (Starlette sets content-type)
    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # nginx: disable buffering
        },
    )
