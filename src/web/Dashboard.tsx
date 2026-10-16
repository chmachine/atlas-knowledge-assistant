import { useEffect, useState, type FormEvent } from "react";
import { api, type Assumption, type DashboardData, type EvalSummary, type Rate } from "./api";
import { costTotalNote } from "./dashboardText";

const DAY_CHOICES = [7, 14, 30];
const MIN_MINUTES = 1;
const MAX_MINUTES = 60;
const DEFAULT_MINUTES = 6;

const pctOf = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);
const rate = (r: Rate) => (r.total === 0 ? "–" : `${Math.round((100 * r.pass) / r.total)}% (${r.pass}/${r.total})`);
const secs = (v: number | null) => (v === null ? "–" : `${v.toFixed(1)} s`);
const usd = (v: number | null, digits = 4) => (v === null ? "–" : `$${v.toFixed(digits)}`);
const hours = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1)} h`);
const dateOf = (iso: string) => iso.replace("T", " ").slice(0, 16);

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <li className="kpi">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {sub && <span className="kpi-sub">{sub}</span>}
    </li>
  );
}

/** Questions per day as bars. Drawn by hand so the page needs no chart library; the same numbers are in the table below it. */
function DayChart({ days }: { days: DashboardData["per_day"] }) {
  const W = 640;
  const H = 150;
  const top = 8;
  const left = 28;
  const bottom = 22;
  const max = Math.max(1, ...days.map((d) => d.questions));
  const step = (W - left) / days.length;
  const bar = Math.max(step * 0.65, 2);
  const labelEvery = Math.ceil(days.length / 10);
  const y = (v: number) => top + (H - top - bottom) * (1 - v / max);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Questions per day over the last ${days.length} days; the busiest day had ${max}.`}>
      <line x1={left} x2={W} y1={y(0)} y2={y(0)} className="axis" />
      <text x={left - 6} y={y(max) + 4} textAnchor="end" className="tick">{max}</text>
      <text x={left - 6} y={y(0) + 4} textAnchor="end" className="tick">0</text>
      {days.map((d, i) => {
        const x = left + i * step + (step - bar) / 2;
        return (
          <g key={d.day}>
            <rect x={x} y={y(d.questions)} width={bar} height={Math.max(y(0) - y(d.questions), d.questions ? 1 : 0)} rx="2" className="bar">
              <title>{`${d.day}: ${d.questions} question${d.questions === 1 ? "" : "s"}, ${d.active_users} active user${d.active_users === 1 ? "" : "s"}`}</title>
            </rect>
            {i % labelEvery === 0 || i === days.length - 1 ? (
              <text x={x + bar / 2} y={H - 6} textAnchor="middle" className="tick">{d.day.slice(8)}</text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function EvalTable({ data }: { data: NonNullable<DashboardData["latest_eval"]> }) {
  const rows: [string, (s: EvalSummary) => string][] = [
    ["Citations correct", (s) => rate(s.citation_correct)],
    ["Blocked-for-role questions refused (must be 100%)", (s) => rate(s.blocked_refused)],
    ["No forbidden text in the answer", (s) => rate(s.leak_free)],
    ["Faithfulness to the cited sources (judge, 1 to 5)", (s) => (s.faithfulness_mean === null ? "–" : s.faithfulness_mean.toFixed(2))],
    ["Average cost of an answer", (s) => usd(s.avg_answer_cost_usd)],
    ["Average response time", (s) => secs(s.avg_latency_s)],
  ];
  return (
    <>
      <p className="muted small">
        Run of {dateOf(data.run.created_at)} UTC{data.run.git_sha ? `, code ${data.run.git_sha}` : ""}. Answers by {data.run.model}, graded by {data.run.judge_model}. {data.vector.n} questions per mode.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Metric</th><th>Vector search</th><th>Agentic search</th></tr>
          </thead>
          <tbody>
            {rows.map(([label, f]) => (
              <tr key={label}><td>{label}</td><td>{f(data.vector)}</td><td>{f(data.agentic)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function AssumptionForm({ assumption, onSaved }: { assumption: Assumption; onSaved: () => void }) {
  const [value, setValue] = useState(String(assumption.minutes_per_search));
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  useEffect(() => setValue(String(assumption.minutes_per_search)), [assumption.minutes_per_search]);

  async function save(minutes: number) {
    setStatus(null);
    try {
      await api("/api/admin/settings", { method: "PUT", body: { minutes_per_search: minutes } });
      setStatus({ kind: "ok", text: "Saved." });
      onSaved();
    } catch {
      setStatus({ kind: "error", text: `Could not save. Use a whole number from ${MIN_MINUTES} to ${MAX_MINUTES}.` });
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(value);
    if (!Number.isInteger(n) || n < MIN_MINUTES || n > MAX_MINUTES) return setStatus({ kind: "error", text: `Use a whole number from ${MIN_MINUTES} to ${MAX_MINUTES}.` });
    void save(n);
  };

  return (
    <form className="assumption" onSubmit={submit} noValidate>
      <label htmlFor="minutes">Minutes one manual search for an answer takes (an assumption, not a measurement)</label>
      <div className="assumption-row">
        <input id="minutes" type="number" inputMode="numeric" min={MIN_MINUTES} max={MAX_MINUTES} step={1} value={value} onChange={(e) => setValue(e.target.value)} />
        <button type="submit" className="primary">Save</button>
        <button type="button" className="link" onClick={() => void save(DEFAULT_MINUTES)}>Reset to {DEFAULT_MINUTES}</button>
      </div>
      <p className="muted small" aria-live="polite">
        {status ? <span className={status.kind === "error" ? "form-error" : undefined}>{status.text} </span> : null}
        {assumption.updated_at ? `Last changed by ${assumption.updated_by ?? "someone"} on ${dateOf(assumption.updated_at)} UTC.` : "Using the default value."}
      </p>
    </form>
  );
}

export function Dashboard() {
  const [days, setDays] = useState(14);
  const [simulated, setSimulated] = useState(true);
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    api<DashboardData>(`/api/admin/dashboard?days=${days}&simulated=${simulated ? 1 : 0}`)
      .then((d) => (setData(d), setError(null)))
      .catch((e) => setError(e?.status === 403 ? "This page is for the Admin role only." : "Could not load the dashboard."));
  }, [days, simulated, reload]);

  if (error && !data) return <p role="alert" className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const t = data.totals;
  const ts = data.time_saved;
  return (
    <section className="dashboard">
      <h1>Adoption dashboard</h1>
      <p className="muted">How the assistant is used, what it costs and how well it answers. Numbers come from the audit log and the evaluation runs. No question or answer text is shown here.</p>

      <form className="filters" onSubmit={(e) => e.preventDefault()}>
        <label>Period
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {DAY_CHOICES.map((d) => <option key={d} value={d}>Last {d} days</option>)}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={simulated} onChange={(e) => setSimulated(e.target.checked)} />
          Include simulated history
        </label>
        {data.window.simulated_questions > 0 && (
          <span className="badge badge-warn" role="note">
            Simulated data: {data.window.simulated_questions} of {t.questions} questions here are seeded history, not real visitors
          </span>
        )}
      </form>

      <ul className="kpis">
        <Kpi label="Questions" value={String(t.questions)} sub={`${t.answered} answered, ${t.refused} refused${t.failed ? `, ${t.failed} failed` : ""}`} />
        <Kpi label="Active users" value={String(t.active_users)} sub={`in the last ${data.window.days} days`} />
        <Kpi label="Answered with a source" value={pctOf(t.answered_with_source_rate)} sub={`${t.answered_with_source} of ${t.questions - t.failed} questions`} />
        <Kpi label="Refusal rate" value={pctOf(t.refusal_rate)} sub="no supported answer in the documents the role can read" />
        <Kpi label="Thumbs up" value={pctOf(t.thumbs.up_rate)} sub={t.thumbs.up + t.thumbs.down ? `of ${t.thumbs.up + t.thumbs.down} rated answers` : "no ratings yet"} />
        <Kpi label="Response time" value={secs(t.latency_s.avg)} sub={`average; 95th percentile ${secs(t.latency_s.p95)}`} />
        <Kpi label="Cost per question" value={usd(t.cost_usd.per_question)} sub={costTotalNote(t.cost_usd.total, data.window.simulated_questions)} />
        <Kpi label="Estimated time saved" value={hours(ts.hours)} sub={`assumption: ${ts.minutes_per_search} min per manual search × ${ts.answered} answered questions`} />
      </ul>

      <h2>Questions per day</h2>
      {t.questions === 0 ? <p className="muted">No questions in this period yet.</p> : <DayChart days={data.per_day} />}
      <details className="steps">
        <summary>Show as a table</summary>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Day (UTC)</th><th>Questions</th><th>Active users</th></tr></thead>
            <tbody>
              {data.per_day.map((d) => <tr key={d.day}><td>{d.day}</td><td>{d.questions}</td><td>{d.active_users}</td></tr>)}
            </tbody>
          </table>
        </div>
      </details>

      <h2>Time saved: the assumption</h2>
      <p className="muted small">Estimated time saved is answered questions times the minutes one manual search would have taken. Refused and failed questions save nothing. It is an estimate, and you can change the assumption.</p>
      <AssumptionForm assumption={ts.assumption} onSaved={() => setReload((n) => n + 1)} />

      <h2>Vector search and agentic search, in use</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Mode</th><th>Questions</th><th>Average response time</th><th>Average cost per question</th></tr></thead>
          <tbody>
            {data.by_mode.map((m) => (
              <tr key={m.mode}><td>{m.mode === "vector" ? "Vector search" : "Agentic search"}</td><td>{m.questions}</td><td>{secs(m.avg_latency_s)}</td><td>{usd(m.avg_cost_usd)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Latest evaluation</h2>
      {data.latest_eval ? <EvalTable data={data.latest_eval} /> : <p className="muted">No evaluation has been run yet.</p>}
      <p className="muted small">The evaluation set is small and written by the author, so it shows regressions and large differences, not a benchmark.</p>
    </section>
  );
}
