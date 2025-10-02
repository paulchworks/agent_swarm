import React, { useMemo, useRef, useState } from 'react'

// Types
interface AgentSpec {
  name: string
  system_prompt: string
  model?: string
}
interface SwarmSettings {
  max_handoffs: number
  max_iterations: number
  execution_timeout: number
  node_timeout: number
  repetitive_handoff_detection_window: number
  repetitive_handoff_min_unique_agents: number
  entry_point: string
}
interface RunResponse {
  status: string
  node_history: string[]
  output?: any
  meta?: Record<string, any>
}

type TraceEvent = {
  ts: number
  type: 'ready' | 'start' | 'log' | 'error' | 'done' | 'summary' | 'client-error'
  level?: string
  message?: string
  run_id?: string
  task?: string
  status?: string
  node_history?: string[]
  has_output?: boolean
}

// Defaults
const DEFAULT_AGENTS: AgentSpec[] = [
  { name: 'researcher', system_prompt: 'You are a research specialist...' },
  { name: 'coder',      system_prompt: 'You are a coding specialist...' },
  { name: 'reviewer',   system_prompt: 'You are a code review specialist...' },
  { name: 'architect',  system_prompt: 'You are a system architecture specialist...' },
]
const DEFAULT_SETTINGS: SwarmSettings = {
  max_handoffs: 20,
  max_iterations: 20,
  execution_timeout: 900,
  node_timeout: 300,
  repetitive_handoff_detection_window: 8,
  repetitive_handoff_min_unique_agents: 3,
  entry_point: 'researcher',
}

// ---- Small UI primitives ----
const Card: React.FC<React.PropsWithChildren<{ title?: string; right?: React.ReactNode }>> = ({ title, right, children }) => (
  <section className="bg-slate-900/60 backdrop-blur border border-white/10 rounded-2xl p-5">
    {(title || right) && (
      <div className="flex items-center justify-between mb-4">
        {title && <h2 className="text-base font-semibold tracking-tight">{title}</h2>}
        {right}
      </div>
    )}
    {children}
  </section>
)

const Label: React.FC<React.PropsWithChildren> = ({ children }) => (
  <label className="block text-xs uppercase tracking-wide text-slate-300/80 mb-1">{children}</label>
)

const Input = (props: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input
    {...props}
    className={`w-full bg-slate-950 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/60 focus:border-indigo-500/60 ${props.className ?? ''}`}
  />
)

const Textarea = (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea
    {...props}
    className={`w-full bg-slate-950 border border-white/10 rounded-lg p-3 text-sm min-h-[7rem] focus:outline-none focus:ring-2 focus:ring-indigo-500/60 focus:border-indigo-500/60 ${props.className ?? ''}`}
  />
)

const Button: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ className, ...rest }) => (
  <button
    {...rest}
    className={`w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-semibold disabled:opacity-60 ${className ?? ''}`}
  />
)

export default function App() {
  const apiBase = import.meta.env.VITE_API_BASE || '/'

  const [task, setTask] = useState('')
  const [agents, setAgents] = useState<AgentSpec[]>(DEFAULT_AGENTS)
  const [settings, setSettings] = useState<SwarmSettings>(DEFAULT_SETTINGS)

  const [loading, setLoading] = useState(false)
  const [resp, setResp] = useState<RunResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [runId, setRunId] = useState<string | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [traces, setTraces] = useState<TraceEvent[]>([])
  const esRef = useRef<EventSource | null>(null)
  const traceEndRef = useRef<HTMLDivElement | null>(null)

  const entryOptions = useMemo(() => agents.map((a) => a.name), [agents])

  function addTrace(t: Omit<TraceEvent, 'ts'>) {
    setTraces((prev) => [...prev, { ...t, ts: Date.now() }])
    // Auto-scroll trace panel (if present)
    queueMicrotask(() => traceEndRef.current?.scrollIntoView({ behavior: 'smooth' }))
  }

  function clearTraces() {
    setTraces([])
  }

  async function fetchFinal(id: string) {
    // Poll until final result is ready (server returns 202 while running)
    for (let i = 0; i < 60; i++) { // up to ~60s; tweak as needed
      const r = await fetch(`${apiBase}api/result/${id}`)
      if (r.status === 202) {
        await new Promise((res) => setTimeout(res, 1000))
        continue
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data: RunResponse = await r.json()
      setResp(data)
      return
    }
    throw new Error('Timed out waiting for result')
  }

  const runSwarm = async () => {
    if (!task || !task.trim()) {
      setError('Please enter a task before running the swarm.')
      return
    }

    // Reset state
    setError(null)
    setResp(null)
    setRunId(null)
    clearTraces()

    setLoading(true)
    setStreaming(true)

    try {
      const payload = { task: task.trim(), agents, settings }
      const startRes = await fetch(`${apiBase}api/run/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!startRes.ok) throw new Error(`HTTP ${startRes.status}`)
      const { run_id } = await startRes.json()
      setRunId(run_id)

      // Open SSE stream
      const es = new EventSource(`${apiBase}api/stream/${run_id}`)
      esRef.current = es

      es.addEventListener('ready', (e: MessageEvent) => {
        addTrace({ type: 'ready', message: 'stream ready', run_id })
      })
      es.addEventListener('start', (e: MessageEvent) => {
        const data = safeParse(e.data)
        addTrace({ type: 'start', run_id, task: data?.task })
      })
      es.addEventListener('log', (e: MessageEvent) => {
        const data = safeParse(e.data)
        addTrace({ type: 'log', level: data?.level || 'LOG', message: data?.message })
      })
      es.addEventListener('error', (e: MessageEvent) => {
        const data = safeParse(e.data)
        addTrace({ type: 'error', message: data?.error || 'server error' })
      })
      es.addEventListener('done', async (e: MessageEvent) => {
        const data = safeParse(e.data)
        addTrace({ type: 'done', status: data?.status, has_output: data?.has_output })
        es.close()
        esRef.current = null
        try {
          await fetchFinal(run_id)
        } catch (err: any) {
          setError(err?.message || 'Failed to fetch final result')
        } finally {
          setLoading(false)
          setStreaming(false)
        }
      })
      es.addEventListener('summary', (e: MessageEvent) => {
        const data = safeParse(e.data)
        addTrace({ type: 'summary', status: data?.status, has_output: data?.has_output })
      })

      es.onerror = () => {
        addTrace({ type: 'client-error', message: 'stream connection error' })
      }
    } catch (e: any) {
      setError(e?.message || 'Request failed')
      setLoading(false)
      setStreaming(false)
      if (esRef.current) {
        esRef.current.close()
        esRef.current = null
      }
    }
  }

  const updateAgent = (idx: number, patch: Partial<AgentSpec>) => {
    setAgents((prev) => {
      const copy = [...prev]
      copy[idx] = { ...copy[idx], ...patch }
      return copy
    })
  }

  const addAgent = () => setAgents((prev) => [...prev, { name: `agent_${prev.length + 1}`, system_prompt: 'You are a helpful specialist...' }])
  const removeAgent = (idx: number) => setAgents((prev) => prev.filter((_, i) => i !== idx))

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 to-slate-900 text-slate-100">
      <header className="px-6 py-4 border-b border-white/10">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <h1 className="text-lg font-semibold">Strands Swarm Console</h1>
          <div className="text-xs opacity-70">Connected to <code className="bg-slate-800/70 px-1.5 py-0.5 rounded">{apiBase}</code></div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-6 grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card title="Task">
            <Textarea value={task} onChange={(e) => setTask(e.target.value)} placeholder="Describe what the swarm should do..." />
          </Card>

          <Card title="Swarm Settings">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <FieldNumber label="Max handoffs" value={settings.max_handoffs} onChange={(v) => setSettings((s) => ({ ...s, max_handoffs: v }))} />
              <FieldNumber label="Max iterations" value={settings.max_iterations} onChange={(v) => setSettings((s) => ({ ...s, max_iterations: v }))} />
              <FieldNumber label="Exec timeout (s)" value={settings.execution_timeout} onChange={(v) => setSettings((s) => ({ ...s, execution_timeout: v }))} />
              <FieldNumber label="Node timeout (s)" value={settings.node_timeout} onChange={(v) => setSettings((s) => ({ ...s, node_timeout: v }))} />
              <FieldNumber label="Repetitive window" value={settings.repetitive_handoff_detection_window} onChange={(v) => setSettings((s) => ({ ...s, repetitive_handoff_detection_window: v }))} />
              <FieldNumber label="Min unique agents" value={settings.repetitive_handoff_min_unique_agents} onChange={(v) => setSettings((s) => ({ ...s, repetitive_handoff_min_unique_agents: v }))} />
            </div>
            <div className="mt-4">
              <Label>Entry point</Label>
              <select
                className="bg-slate-950 border border-white/10 rounded-lg px-3 py-2 text-sm"
                value={settings.entry_point}
                onChange={(e) => setSettings((s) => ({ ...s, entry_point: e.target.value }))}
              >
                {entryOptions.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
          </Card>

          <Card title="Agents" right={<button onClick={addAgent} className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-sm">+ Add Agent</button>}>
            <div className="space-y-4">
              {agents.map((a, idx) => (
                <div key={idx} className="rounded-xl bg-slate-950/60 border border-white/10 p-4">
                  <div className="grid md:grid-cols-3 gap-3">
                    <div>
                      <Label>Name</Label>
                      <Input value={a.name} onChange={(e) => updateAgent(idx, { name: e.target.value })} />
                    </div>
                    <div>
                      <Label>Model (optional)</Label>
                      <Input placeholder="e.g. gpt-4o or a Bedrock model id" value={a.model || ''} onChange={(e) => updateAgent(idx, { model: e.target.value || undefined })} />
                    </div>
                    <div className="flex items-end">
                      <button onClick={() => removeAgent(idx)} className="w-full px-3 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm border border-white/10">Remove</button>
                    </div>
                  </div>
                  <div className="mt-3">
                    <Label>System prompt</Label>
                    <Textarea value={a.system_prompt} onChange={(e) => updateAgent(idx, { system_prompt: e.target.value })} />
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Run" right={
            runId ? <span className="text-[11px] opacity-70">Run ID: <code className="bg-slate-800/70 px-1 py-0.5 rounded">{runId.slice(0,8)}…</code></span> : null
          }>
            <Button onClick={runSwarm} disabled={loading || streaming}>
              {loading || streaming ? 'Running…' : 'Run Swarm'}
            </Button>
            {error && <p className="text-red-400 text-sm mt-3">{error}</p>}
          </Card>

          {/* ---- Live Trace ---- */}
          <Card title="Live Trace" right={<button onClick={clearTraces} className="px-2 py-1 text-xs bg-slate-800 hover:bg-slate-700 rounded-lg border border-white/10">Clear</button>}>
            <div className="bg-slate-950 border border-white/10 rounded-xl p-3 text-xs font-mono max-h-[45vh] overflow-auto">
              {traces.length === 0 && <div className="opacity-60">No traces yet.</div>}
              {traces.map((t, i) => (
                <div key={i} className={
                  t.type === 'error' || t.type === 'client-error' ? 'text-red-300' : t.type === 'done' ? 'text-emerald-300' : 'text-slate-200'
                }>
                  <span className="opacity-60">[{new Date(t.ts).toLocaleTimeString()}]</span>{' '}
                  <span className="uppercase opacity-70">{t.type}</span>{' '}
                  {t.level && <span className="uppercase opacity-70">{t.level}</span>}{' '}
                  {t.message && <span>{t.message}</span>}
                  {t.status && <span>status={t.status}</span>}
                  {typeof t.has_output === 'boolean' && <span> has_output={String(t.has_output)}</span>}
                </div>
              ))}
              <div ref={traceEndRef} />
            </div>
          </Card>

          {/* ---- Status & Output ---- */}
          <Card title="Status & Output">
            {!resp && !loading && !streaming && (
              <p className="text-sm opacity-70">No run yet.</p>
            )}

            {(loading || streaming) && (
              <p className="text-sm opacity-90">Executing… may take a while for long tasks.</p>
            )}

            {!!resp && (
              <div className="space-y-4">
                <div>
                  <Label>Status</Label>
                  <div className="font-mono text-sm">{resp.status}</div>
                </div>

                <div>
                  <Label>Node history</Label>
                  <div className="flex flex-wrap gap-2">
                    {resp.node_history?.length ? (
                      resp.node_history.map((id, i) => (
                        <span key={i} className="px-2 py-1 rounded-md border border-white/10 bg-slate-950 text-xs font-mono">{id}</span>
                      ))
                    ) : (
                      <span className="opacity-70 text-sm">—</span>
                    )}
                  </div>
                </div>

                <div>
                  <Label>Output</Label>
                  <pre className="bg-slate-950 border border-white/10 rounded-xl p-3 overflow-auto text-xs max-h-[40vh]">
                    {typeof resp.output === 'string' ? resp.output : JSON.stringify(resp.output, null, 2)}
                  </pre>
                </div>

                {resp.meta && Object.keys(resp.meta).length > 0 && (
                  <div>
                    <Label>Meta</Label>
                    <pre className="bg-slate-950 border border-white/10 rounded-xl p-3 overflow-auto text-xs max-h-[30vh]">
                      {JSON.stringify(resp.meta, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>
      </main>

      <footer className="px-6 py-6 border-t border-white/10 text-center opacity-70 text-xs">
        Strands multi-agent Swarm Console • React + Vite + Tailwind
      </footer>
    </div>
  )
}

function FieldNumber({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <Label>{label}</Label>
      <Input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  )
}

function safeParse(s: string) {
  try { return JSON.parse(s) } catch { return undefined }
}
