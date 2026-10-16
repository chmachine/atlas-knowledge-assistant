import { useEffect, useState } from "react";
import { api, type AuditDetail, type AuditRow } from "./api";

const PAGE = 25;
type Filters = { source: string; mode: string; role: string; refused: string; injection: string; q: string };
const EMPTY: Filters = { source: "live", mode: "", role: "", refused: "", injection: "", q: "" };

const usd = (v: number | null) => (v === null ? "–" : `$${v.toFixed(4)}`);
const when = (iso: string) => iso.replace("T", " ").slice(0, 16);

export function Audit() {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ total: number; rows: AuditRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<AuditDetail | null>(null);

  useEffect(() => {
    const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset), source: filters.source });
    for (const k of ["mode", "role", "refused", "injection", "q"] as const) if (filters[k]) qs.set(k, filters[k]);
    api<{ total: number; rows: AuditRow[] }>(`/api/admin/audit?${qs}`)
      .then((d) => (setData(d), setError(null)))
      .catch((e) => setError(e?.status === 403 ? "This page is for the Admin role only." : "Could not load the audit log."));
  }, [filters, offset]);

  const set = (patch: Partial<Filters>) => (setFilters((f) => ({ ...f, ...patch })), setOffset(0));
  const show = (id: string) => api<AuditDetail>(`/api/admin/audit/${id}`).then(setOpen).catch(() => setError("Could not load that entry."));

  if (error && !data) return <p role="alert" className="error">{error}</p>;

  return (
    <section className="audit">
      <h1>Audit log</h1>
      <p className="muted">
        Every question, how it was answered and what it cost. Personal data was removed before anything was written. By default only real visitors are shown.
      </p>

      <form className="filters" onSubmit={(e) => e.preventDefault()}>
        <label>Source
          <select value={filters.source} onChange={(e) => set({ source: e.target.value })}>
            <option value="live">Visitors</option><option value="simulated">Simulated</option><option value="eval">Eval runs</option><option value="all">All</option>
          </select>
        </label>
        <label>Mode
          <select value={filters.mode} onChange={(e) => set({ mode: e.target.value })}>
            <option value="">Any</option><option value="vector">Vector</option><option value="agentic">Agentic</option>
          </select>
        </label>
        <label>Role
          <select value={filters.role} onChange={(e) => set({ role: e.target.value })}>
            <option value="">Any</option><option value="employee">Employee</option><option value="it_ops">IT Ops</option><option value="hr">HR</option><option value="finance">Finance</option>
          </select>
        </label>
        <label>Outcome
          <select value={filters.refused} onChange={(e) => set({ refused: e.target.value })}>
            <option value="">Any</option><option value="0">Answered</option><option value="1">Refused</option>
          </select>
        </label>
        <label>Injection
          <select value={filters.injection} onChange={(e) => set({ injection: e.target.value })}>
            <option value="">Any</option><option value="1">Detected</option><option value="0">Not detected</option>
          </select>
        </label>
        <label className="grow">Search question
          <input type="search" value={filters.q} maxLength={100} onChange={(e) => set({ q: e.target.value })} placeholder="text in the question" />
        </label>
      </form>

      {!data ? <p className="muted">Loading…</p> : data.rows.length === 0 ? <p className="muted">No entries match.</p> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>When (UTC)</th><th>Role</th><th>Mode</th><th>Question</th><th>Outcome</th><th>Time</th><th>Cost</th></tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td>{when(r.created_at)}</td>
                  <td>{r.role}</td>
                  <td>{r.mode}</td>
                  <td className="q"><button className="link" onClick={() => show(r.id)}>{r.question.length > 80 ? `${r.question.slice(0, 80)}…` : r.question}</button></td>
                  <td>
                    {r.error ? <span className="badge badge-alert">error</span> : r.refused ? <span className="badge badge-warn">refused: {r.refusal_reason}</span> : "answered"}
                    {r.injection_detected ? <span className="badge badge-alert">injection</span> : null}
                    {r.fell_back ? <span className="badge">fallback</span> : null}
                    {r.source !== "live" ? <span className="badge badge-warn">{r.source === "simulated" ? "simulated" : r.source}</span> : null}
                  </td>
                  <td>{r.latency_ms === null ? "–" : `${(r.latency_ms / 1000).toFixed(1)} s`}</td>
                  <td>{usd(r.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && (
        <div className="pager">
          <span className="muted small">{data.total} entr{data.total === 1 ? "y" : "ies"}{data.total > PAGE ? `, showing ${offset + 1}–${Math.min(offset + PAGE, data.total)}` : ""}</span>
          <button className="link" disabled={offset === 0} onClick={() => setOffset(Math.max(offset - PAGE, 0))}>← Newer</button>
          <button className="link" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Older →</button>
        </div>
      )}

      {open && (
        <aside className="detail" aria-label="Entry details">
          <button className="link close" onClick={() => setOpen(null)}>Close</button>
          <h2>{open.mode} · {open.role} · {when(open.created_at)}{open.source !== "live" ? ` · ${open.source}` : ""}</h2>
          <h3>Question</h3><p>{open.question}</p>
          <h3>Answer{open.refused ? ` (refused: ${open.refusal_reason})` : ""}</h3><p className="pre">{open.answer || "–"}</p>
          {open.error && <><h3>Error</h3><p className="pre">{open.error}</p></>}
          {open.tool_calls.length > 0 && (
            <><h3>Steps</h3>
              <ol>{open.tool_calls.map((t, i) => <li key={i}><code>{t.tool}</code> {typeof t.input === "string" ? `"${t.input}"` : JSON.stringify(t.input)} → {t.error ? "error" : `${t.found} results`}</li>)}</ol></>
          )}
          <h3>Passages</h3>
          <p className="small">Retrieved: {open.retrieved_chunk_ids.length ? open.retrieved_chunk_ids.join(", ") : "–"}</p>
          <p className="small">Cited: {open.cited_chunk_ids.length ? open.cited_chunk_ids.join(", ") : "–"}</p>
          <h3>Numbers</h3>
          <p className="small">
            {open.model ?? "no model"} · {open.input_tokens ?? 0} tokens in, {open.output_tokens ?? 0} out · {usd(open.cost_usd)} · {open.latency_ms ?? 0} ms · {open.pii_redactions} personal-data items removed
            {open.feedback ? ` · feedback ${open.feedback === 1 ? "👍" : "👎"}` : ""}
          </p>
        </aside>
      )}
    </section>
  );
}
