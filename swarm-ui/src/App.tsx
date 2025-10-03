import React, { useMemo, useRef, useState, useEffect } from 'react'

// Types
interface AgentSpec { name: string; system_prompt: string; model?: string }
interface SwarmSettings {
  max_handoffs: number
  max_iterations: number
  execution_timeout: number
  node_timeout: number
  repetitive_handoff_detection_window: number
  repetitive_handoff_min_unique_agents: number
  entry_point: string
}
type AgentTurn = {
  agent: string; role?: string | null; text: string; stop_reason?: string | null
  usage?: Record<string, any> | null; metrics?: Record<string, any> | null
}
interface RunResponse {
  status: string
  node_history: string[]
  output?: any
  meta?: Record<string, any>
  transcript?: AgentTurn[]
}
type TraceEvent = {
  ts: number
  type: 'ready' | 'start' | 'log' | 'error' | 'done' | 'summary' | 'client-error'
  level?: string; message?: string; run_id?: string; task?: string; status?: string
  node_history?: string[]; has_output?: boolean
  output_preview?: string
  transcript_preview?: Array<{ agent: string; preview: string }>
}

// Defaults
const DEFAULT_AGENTS: AgentSpec[] = [
  { name: 'researcher', system_prompt: 'You are a research specialist...' },
  { name: 'coder',      system_prompt: 'You are a coding specialist...' },
  { name: 'reviewer',   system_prompt: 'You are a code review specialist...' },
  { name: 'architect',  system_prompt: 'You are a system architecture specialist...' },
]
const DEFAULT_SETTINGS: SwarmSettings = {
  max_handoffs: 20, max_iterations: 20, execution_timeout: 900, node_timeout: 300,
  repetitive_handoff_detection_window: 8, repetitive_handoff_min_unique_agents: 3,
  entry_point: 'researcher',
}

// ---- UI primitives ----
const Card: React.FC<React.PropsWithChildren<{ title?: string; right?: React.ReactNode; className?: string }>> = ({ title, right, children, className }) => (
  <section className={`bg-slate-900/60 backdrop-blur border border-white/10 rounded-2xl p-5 ${className ?? ''}`}>
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
  <label className="block text-[11px] uppercase tracking-wide text-slate-300/80 mb-1">{children}</label>
)
const Input = (props: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input {...props}
    className={`w-full bg-slate-950 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/60 focus:border-indigo-500/60 ${props.className ?? ''}`} />
)
const Textarea = (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea {...props}
    className={`w-full bg-slate-950 border border-white/10 rounded-lg p-2 text-sm min-h-[2.75rem] focus:outline-none focus:ring-2 focus:ring-indigo-500/60 focus:border-indigo-500/60 ${props.className ?? ''}`} />
)
const Button: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ className, ...rest }) => (
  <button {...rest} className={`px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-semibold disabled:opacity-60 ${className ?? ''}`} />
)
function Tabs({ tabs, active, onChange }: { tabs: string[]; active: string; onChange: (k: string) => void }) {
  return (
    <div className="flex gap-2 mb-3 border-b border-white/10">
      {tabs.map((t) => (
        <button key={t} onClick={() => onChange(t)}
          className={`px-3 py-2 text-sm rounded-t-lg border-b-2 transition-colors ${
            active === t ? 'border-emerald-500 text-emerald-300'
                         : 'border-transparent text-slate-300 hover:text-slate-100'}`}>
          {t}
        </button>
      ))}
    </div>
  )
}
function Accordion({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-xl border border-white/10">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-sm bg-slate-900/60 rounded-t-xl">
        <span className="text-slate-200">{title}</span>
        <span className="text-slate-400">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="p-3">{children}</div>}
    </div>
  )
}
function tokenSummary(usage?: Record<string, any> | null) {
  if (!usage) return null
  const it = usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens
  const ot = usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens
  const tt = usage.totalTokens ?? usage.total_tokens ?? (it && ot ? it + ot : undefined)
  const parts: string[] = []
  if (tt != null) parts.push(`tok ${tt}`)
  else if (it != null || ot != null) parts.push(`in ${it ?? '?'}/out ${ot ?? '?'}`)
  return parts.length ? parts.join(' · ') : null
}

export default function App() {
  const apiBase = import.meta.env.VITE_API_BASE || '/'
  // state
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
  const [activeTab, setActiveTab] = useState<'Trace' | 'Transcript' | 'Output'>('Trace')
  const entryOptions = useMemo(() => agents.map(a => a.name), [agents])

  // helpers
  function buildUrl(path: string) {
    const normalized = path.replace(/^\/+/, '')
    if (!apiBase || apiBase === '/') return '/' + normalized
    try { return new URL(normalized, apiBase).toString() }
    catch { return `${apiBase.replace(/\/+$/, '/')}${normalized}` }
  }
  function addTrace(t: Omit<TraceEvent, 'ts'>) {
    setTraces(prev => [...prev, { ...t, ts: Date.now() }])
    queueMicrotask(() => traceEndRef.current?.scrollIntoView({ behavior: 'smooth' }))
  }
  function clearTraces() { setTraces([]) }
  async function fetchFinal(id: string) {
    const url = buildUrl(`api/result/${id}`)
    for (let i = 0; i < 120; i++) {
      const r = await fetch(url)
      if (r.status === 202) { await new Promise(res => setTimeout(res, 1000)); continue }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data: RunResponse = await r.json()
      setResp(data); return
    }
    throw new Error('Timed out waiting for result')
  }
  useEffect(() => () => { esRef.current?.close(); esRef.current = null }, [])

  const runSwarm = async () => {
    if (!task || !task.trim()) { setError('Please enter a task before running the swarm.'); return }
    setError(null); setResp(null); setRunId(null); clearTraces(); esRef.current?.close(); esRef.current = null
    setActiveTab('Trace'); setLoading(true); setStreaming(true)
    try {
      const payload = { task: task.trim(), agents, settings }
      const startRes = await fetch(buildUrl('api/run/start'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (!startRes.ok) throw new Error(`HTTP ${startRes.status}`)
      const { run_id } = await startRes.json(); setRunId(run_id)
      const es = new EventSource(buildUrl(`api/stream/${run_id}`)); esRef.current = es
      es.addEventListener('ready', () => addTrace({ type: 'ready', message: 'stream ready', run_id }))
      es.addEventListener('start', (e: MessageEvent) => { const d = safeParse(e.data); addTrace({ type: 'start', run_id, task: d?.task }) })
      es.addEventListener('log', (e: MessageEvent) => { const d = safeParse(e.data); addTrace({ type: 'log', level: d?.level || 'LOG', message: d?.message }) })
      es.addEventListener('error', (e: MessageEvent) => { const d = safeParse((e as any).data); addTrace({ type: 'error', message: d?.error || 'server error' }) })
      es.addEventListener('done', async (e: MessageEvent) => {
        const d = safeParse(e.data)
        addTrace({ type: 'done', status: d?.status, has_output: d?.has_output, output_preview: d?.output_preview, transcript_preview: d?.transcript_preview })
        es.close(); esRef.current = null
        try { await fetchFinal(run_id) } catch (err: any) { setError(err?.message || 'Failed to fetch final result') }
        finally { setLoading(false); setStreaming(false) }
      })
      es.addEventListener('summary', (e: MessageEvent) => {
        const d = safeParse(e.data)
        addTrace({ type: 'summary', status: d?.status, has_output: d?.has_output, output_preview: d?.output_preview, transcript_preview: d?.transcript_preview })
      })
      es.onerror = () => addTrace({ type: 'client-error', message: 'stream connection error' })
    } catch (e: any) {
      setError(e?.message || 'Request failed'); setLoading(false); setStreaming(false); esRef.current?.close(); esRef.current = null
    }
  }

  const updateAgent = (idx: number, patch: Partial<AgentSpec>) => {
    setAgents(prev => { const copy = [...prev]; copy[idx] = { ...copy[idx], ...patch }; return copy })
  }
  const addAgent = () => setAgents(prev => [...prev, { name: `agent_${prev.length + 1}`, system_prompt: 'You are a helpful specialist...' }])
  const removeAgent = (idx: number) => setAgents(prev => prev.filter((_, i) => i !== idx))

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 to-slate-900 text-slate-100">

      {/* Sticky Header Command Dock */}
      <header className="sticky top-0 z-40 border-b border-white/10 bg-slate-950/80 backdrop-blur">
        <div className="max-w-6xl mx-auto px-6 py-3 flex flex-col gap-2 md:flex-row md:items-center">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-base font-semibold">Strands Swarm Console</h1>
            <div className="text-[11px] opacity-70">Connected to <code className="bg-slate-800/70 px-1.5 py-0.5 rounded">{apiBase}</code></div>
          </div>
          <div className="flex-1 flex items-center gap-2">
            <Textarea
              rows={1}
              placeholder="Describe what the swarm should do…"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              className="flex-1"
            />
            <Button onClick={runSwarm} disabled={loading || streaming}>{loading || streaming ? 'Running…' : 'Run'}</Button>
            {runId && <span className="hidden md:block text-[11px] opacity-70">Run: <code className="bg-slate-800/70 px-1 py-0.5 rounded">{runId.slice(0,8)}…</code></span>}
          </div>
        </div>
        {error && <div className="max-w-6xl mx-auto px-6 pb-3 text-red-400 text-xs">{error}</div>}
      </header>

      {/* Main: Console dominates, Config compact on right */}
      <main className="max-w-6xl mx-auto p-6 grid lg:grid-cols-3 gap-6">
        {/* LEFT: Console */}
        <div className="lg:col-span-2 space-y-6">
          <Card title="Console">
            <Tabs tabs={['Trace', 'Transcript', 'Output']} active={activeTab} onChange={(t) => setActiveTab(t as any)} />

            {activeTab === 'Trace' && (
              <div className="bg-slate-950 border border-white/10 rounded-xl p-3 text-xs font-mono max-h-[65vh] overflow-auto whitespace-pre-wrap break-words">
                {traces.length === 0 && <div className="opacity-60">No traces yet.</div>}
                {traces.map((t, i) => (
                  <div key={i} className={t.type === 'error' || t.type === 'client-error' ? 'text-red-300' : t.type === 'done' ? 'text-emerald-300' : 'text-slate-200'}>
                    <span className="opacity-60">[{new Date(t.ts).toLocaleTimeString()}]</span>{' '}
                    <span className="uppercase opacity-70">{t.type}</span>{' '}
                    {t.level && <span className="uppercase opacity-70">{t.level}</span>}{' '}
                    {t.message && <span>{t.message}</span>}
                    {t.status && <span> status={t.status}</span>}
                    {typeof t.has_output === 'boolean' && <span> has_output={String(t.has_output)}</span>}
                    {t.output_preview && <div className="mt-1 opacity-80">{t.output_preview.slice(0,240)}{t.output_preview.length>240?'…':''}</div>}
                    {t.transcript_preview?.length ? (
                      <div className="mt-1 space-y-0.5">
                        {t.transcript_preview.map((p, j) => (
                          <div key={j} className="opacity-80"><span className="text-sky-300">{p.agent}</span>: {p.preview}</div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
                <div ref={traceEndRef} />
              </div>
            )}

            {activeTab === 'Transcript' && (
              <div className="space-y-3 max-h-[65vh] overflow-auto">
                {!resp?.transcript?.length ? (
                  <div className="text-sm opacity-70">—</div>
                ) : resp.transcript.map((t, i) => (
                  <div key={i} className="rounded-xl border border-white/10 bg-slate-950/60 p-3">
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <span className="text-sm font-medium text-sky-300">{t.agent}</span>
                      {t.role && <span className="text-[11px] px-2 py-0.5 rounded bg-slate-800 border border-white/10">{t.role}</span>}
                      {t.stop_reason && <span className="text-[11px] px-2 py-0.5 rounded bg-slate-800 border border-white/10">stop: {t.stop_reason}</span>}
                      {tokenSummary(t.usage) && <span className="text-[11px] px-2 py-0.5 rounded bg-slate-800 border border-white/10">{tokenSummary(t.usage)}</span>}
                    </div>
                    <div className="whitespace-pre-wrap text-sm leading-relaxed">{t.text || <span className="opacity-60">(no text)</span>}</div>
                  </div>
                ))}
              </div>
            )}

            {activeTab === 'Output' && (
              <div className="max-h-[65vh] overflow-auto">
                {!resp ? (
                  <p className="text-sm opacity-70">No run yet.</p>
                ) : (
                  <pre className="bg-slate-950 border border-white/10 rounded-xl p-3 overflow-auto text-sm whitespace-pre-wrap break-words">
                    {typeof resp.output === 'string' ? resp.output : JSON.stringify(resp.output, null, 2)}
                  </pre>
                )}
              </div>
            )}
          </Card>

          <Card title="Status" className="text-sm">
            {!resp && !loading && !streaming && <p className="opacity-70">No run yet.</p>}
            {(loading || streaming) && <p className="opacity-90">Executing…</p>}
            {!!resp && (
              <div className="grid sm:grid-cols-3 gap-3">
                <div><Label>State</Label><div className="font-mono">{resp.status}</div></div>
                <div>
                  <Label>Node history</Label>
                  <div className="flex flex-wrap gap-1">
                    {resp.node_history?.length
                      ? resp.node_history.map((id, i) => (
                          <span key={i} className="px-2 py-0.5 rounded-md border border-white/10 bg-slate-950 text-[11px] font-mono">{id}</span>
                        ))
                      : <span className="opacity-70">—</span>}
                  </div>
                </div>
                <div>
                  <Label>Meta</Label>
                  <div className="text-[11px] opacity-80">
                    {resp.meta ? JSON.stringify(resp.meta).slice(0,120) + (JSON.stringify(resp.meta).length>120?'…':'') : '—'}
                  </div>
                </div>
              </div>
            )}
          </Card>
        </div>

        {/* RIGHT: Compact Config */}
        <div className="space-y-4 lg:sticky lg:top-[4.25rem] h-fit">
          <Card title="Compact Config">
            <Accordion title="Entry & Limits" defaultOpen>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <Label>Entry point</Label>
                  <select className="w-full bg-slate-950 border border-white/10 rounded-lg px-2 py-1.5 text-sm"
                          value={settings.entry_point}
                          onChange={(e) => setSettings(s => ({ ...s, entry_point: e.target.value }))}>
                    {entryOptions.map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <FieldNumber label="Max handoffs" value={settings.max_handoffs} onChange={(v) => setSettings(s => ({ ...s, max_handoffs: v }))} />
                <FieldNumber label="Max iterations" value={settings.max_iterations} onChange={(v) => setSettings(s => ({ ...s, max_iterations: v }))} />
                <FieldNumber label="Exec timeout (s)" value={settings.execution_timeout} onChange={(v) => setSettings(s => ({ ...s, execution_timeout: v }))} />
                <FieldNumber label="Node timeout (s)" value={settings.node_timeout} onChange={(v) => setSettings(s => ({ ...s, node_timeout: v }))} />
                <FieldNumber label="Repetitive window" value={settings.repetitive_handoff_detection_window} onChange={(v) => setSettings(s => ({ ...s, repetitive_handoff_detection_window: v }))} />
                <FieldNumber label="Min unique agents" value={settings.repetitive_handoff_min_unique_agents} onChange={(v) => setSettings(s => ({ ...s, repetitive_handoff_min_unique_agents: v }))} />
              </div>
            </Accordion>

            <Accordion title={`Agents (${agents.length})`}>
              <div className="space-y-3">
                {agents.map((a, idx) => (
                  <div key={idx} className="rounded-lg bg-slate-950/60 border border-white/10 p-3">
                    <div className="grid grid-cols-2 gap-2">
                      <div><Label>Name</Label><Input value={a.name} onChange={(e) => updateAgent(idx, { name: e.target.value })} /></div>
                      <div><Label>Model</Label><Input placeholder="optional" value={a.model || ''} onChange={(e) => updateAgent(idx, { model: e.target.value || undefined })} /></div>
                    </div>
                    <div className="mt-2">
                      <Label>System prompt</Label>
                      <Textarea className="min-h-[2.25rem]" rows={3} value={a.system_prompt} onChange={(e) => updateAgent(idx, { system_prompt: e.target.value })} />
                    </div>
                    <div className="mt-2 text-right">
                      <button onClick={() => removeAgent(idx)} className="text-xs px-2 py-1 bg-slate-800 hover:bg-slate-700 rounded border border-white/10">Remove</button>
                    </div>
                  </div>
                ))}
                <button onClick={addAgent} className="w-full text-sm px-3 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg">+ Add Agent</button>
              </div>
            </Accordion>
          </Card>

          <Card title="Trace Controls" className="text-sm">
            <div className="flex items-center gap-2">
              <button onClick={clearTraces} className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg border border-white/10">Clear</button>
              <button onClick={() => setActiveTab('Trace')} className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg border border-white/10">Focus Trace</button>
              <button onClick={() => setActiveTab('Output')} className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg border border-white/10">Focus Output</button>
            </div>
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
function safeParse(s: string) { try { return JSON.parse(s) } catch { return undefined } }
