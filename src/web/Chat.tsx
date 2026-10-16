import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Answer } from "./Answer";
import { Feedback } from "./Feedback";
import { ApiError, api, type AskResult, type Mode, type Quota, type Step, type User } from "./api";

const MAX_CHARS = 1000;

const SAMPLES: Record<string, string[]> = {
  employee: ["Ile dni w tygodniu mogę pracować zdalnie?", "What is the gift limit in the Code of Conduct?", "Jakie są widełki płacowe w grupie G3?"],
  it_ops: ["Co zrobić, gdy AtlasWMS przestanie działać?", "Jak długie musi być hasło?", "How fast must we respond to a P1 incident?"],
  hr: ["Ile dni urlopu przysługuje pracownikowi?", "Jakie są widełki płacowe w grupie G3?", "Jak często są oceny okresowe?"],
  finance: ["Jaki jest limit noclegu w delegacji?", "Kto zatwierdza faktury powyżej 25 000 zł?", "Kiedy wykonujemy przelewy do dostawców?"],
};

type Turn = { kind: "user"; text: string } | { kind: "answer"; result: AskResult } | { kind: "error"; text: string };

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429) return "You have reached the daily question limit for this demo. It resets at midnight UTC.";
    if (e.status === 503) return "The assistant is not switched on yet: the demo owner still has to configure it.";
    if (e.status === 502) return "The assistant is temporarily unavailable. Please try again in a moment.";
    if (e.status === 401) return "Your session has ended. Please reload the page and sign in again.";
  }
  return "Something went wrong. Please try again.";
}

export function Chat({ user }: { user: User }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>("vector");
  const [quota, setQuota] = useState<Quota | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<Quota>("/api/quota").then(setQuota).catch(() => undefined);
  }, []);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
  }, [turns, busy]);

  async function send(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setTurns((t) => [...t, { kind: "user", text: q }]);
    setText("");
    setBusy(true);
    try {
      const result = await api<AskResult>("/api/ask", { method: "POST", body: { question: q, mode } });
      setTurns((t) => [...t, { kind: "answer", result }]);
      if (result.quota) setQuota(result.quota);
    } catch (e) {
      setTurns((t) => [...t, { kind: "error", text: errorText(e) }]);
      if (e instanceof ApiError && e.status === 429) api<Quota>("/api/quota").then(setQuota).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(text);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(text);
    }
  };

  const left = quota ? Math.max(quota.limit - quota.used, 0) : null;

  return (
    <section className="chat" aria-label="Chat">
      {turns.length === 0 && (
        <div className="intro">
          <h1>Ask about Atlas Logistics' documents</h1>
          <p className="muted">Answers come only from documents your role can read, and every answer cites its sources. Try one of these, or type your own.</p>
          <ul className="samples">
            {(SAMPLES[user.role] ?? SAMPLES.employee!).map((s) => (
              <li key={s}>
                <button className="sample" onClick={() => send(s)} disabled={busy}>
                  {s}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ol className="turns">
        {turns.map((t, i) => (
          <li key={i} className={`turn turn-${t.kind}`}>
            {t.kind === "user" && <p className="bubble">{t.text}</p>}
            {t.kind === "error" && (
              <p role="alert" className="error">
                {t.text}
              </p>
            )}
            {t.kind === "answer" && <AnswerCard result={t.result} />}
          </li>
        ))}
        {busy && (
          <li className="turn turn-answer" aria-live="polite">
            <p className="muted thinking">Searching the documents you can read…</p>
          </li>
        )}
      </ol>
      <div ref={endRef} />

      <form className="composer" onSubmit={onSubmit}>
        <fieldset className="mode" disabled={busy}>
          <legend className="sr-only">Search mode</legend>
          <label className={mode === "vector" ? "on" : ""}>
            <input type="radio" name="mode" value="vector" checked={mode === "vector"} onChange={() => setMode("vector")} />
            <span>
              <strong>Vector search</strong>
              <span className="muted small"> finds passages by meaning, one model call</span>
            </span>
          </label>
          <label className={mode === "agentic" ? "on" : ""}>
            <input type="radio" name="mode" value="agentic" checked={mode === "agentic"} onChange={() => setMode("agentic")} />
            <span>
              <strong>Agentic search</strong>
              <span className="muted small"> the model searches and reads documents itself, in several steps</span>
            </span>
          </label>
        </fieldset>
        <label className="sr-only" htmlFor="question">
          Your question
        </label>
        <textarea id="question" value={text} onChange={(e) => setText(e.target.value.slice(0, MAX_CHARS))} onKeyDown={onKey} rows={2} placeholder="Ask a question in Polish or English…" disabled={busy} />
        <div className="composer-row">
          <span className="muted small">
            {left !== null ? `${left} of ${quota!.limit} questions left today` : " "}
            {text.length > MAX_CHARS - 100 ? ` · ${MAX_CHARS - text.length} characters left` : ""}
          </span>
          <button type="submit" className="primary" disabled={busy || !text.trim()}>
            {busy ? "Working…" : "Ask"}
          </button>
        </div>
      </form>
    </section>
  );
}

const showInput = (input: unknown): string => {
  if (typeof input === "string") return `"${input}"`;
  if (input && typeof input === "object") return Object.entries(input as Record<string, unknown>).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ");
  return "";
};

function Steps({ result }: { result: AskResult }) {
  if (result.steps.length === 0) return null;
  const label = result.mode === "agentic" ? `How it searched: ${result.steps.length} tool call${result.steps.length === 1 ? "" : "s"}` : "How it searched: vector search";
  return (
    <details className="steps">
      <summary>{label}</summary>
      <ol>
        {result.steps.map((s: Step, i) => (
          <li key={i}>
            <code>{s.tool}</code> {showInput(s.input)} <span className="muted">→ </span>
            {s.error ? <span className="badge badge-alert">error</span> : <span className="muted">{s.found} result{s.found === 1 ? "" : "s"}</span>}
          </li>
        ))}
      </ol>
    </details>
  );
}

function AnswerCard({ result }: { result: AskResult }) {
  return (
    <div className={`answer-card${result.refused ? " refused" : ""}`}>
      {result.refused && <p className="badge badge-warn">No supported answer found in the documents available to your role</p>}
      <Answer text={result.answer} sources={result.sources} />
      {result.injectionDetected && (
        <p className="badge badge-alert" role="note">
          A retrieved passage contained text aimed at an AI assistant. It was treated as data and ignored.
        </p>
      )}
      <Steps result={result} />
      {result.sources.length > 0 && (
        <div className="sources">
          <h3>Sources</h3>
          <ol>
            {result.sources.map((s) => (
              <li key={s.chunkId} value={s.n}>
                <a href={s.url} target="_blank" rel="noopener">
                  {s.title}: {s.section}
                </a>
                {!s.isLatest && <span className="badge badge-warn">older version</span>}
                {s.injectionFlag && <span className="badge badge-alert">contains AI instructions</span>}
                <span className="muted small"> Owner: {s.ownerName}, {s.ownerRole}</span>
                <blockquote>{s.snippet}…</blockquote>
              </li>
            ))}
          </ol>
        </div>
      )}
      <Feedback auditId={result.auditId} />
    </div>
  );
}
