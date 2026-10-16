import { useEffect, useState } from "react";
import { ApiError, api, type SourceDoc } from "./api";

type State = { status: "loading" } | { status: "ok"; data: SourceDoc } | { status: "missing" } | { status: "error" };

/** The source text a citation links to: /source/<document id>#<section>. */
export function Source({ docId }: { docId: string }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const target = decodeURIComponent(location.hash.replace(/^#/, ""));

  useEffect(() => {
    api<SourceDoc>(`/api/source/${encodeURIComponent(docId)}`)
      .then((data) => setState({ status: "ok", data }))
      .catch((e) => setState(e instanceof ApiError && e.status === 404 ? { status: "missing" } : { status: "error" }));
  }, [docId]);

  useEffect(() => {
    if (state.status === "ok" && target) document.getElementById(target)?.scrollIntoView?.({ block: "start" });
  }, [state, target]);

  if (state.status === "loading") return <p className="muted">Loading…</p>;
  if (state.status === "missing") {
    // Not found and not allowed look the same on purpose.
    return (
      <div>
        <h1>Document not found</h1>
        <p className="muted">It does not exist, or your role cannot read it.</p>
        <p>
          <a href="/">Back to the chat</a>
        </p>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <p role="alert" className="error">
        Could not load the document. <a href="/">Back to the chat</a>
      </p>
    );
  }

  const { doc, sections } = state.data;
  return (
    <article className="source">
      <p>
        <a href="/">← Back to the chat</a>
      </p>
      <h1>{doc.title}</h1>
      <p className="muted">
        {doc.department} · owner {doc.owner_name}, {doc.owner_role} · version {doc.version}, effective {doc.effective_date}
        {!doc.is_latest && <span className="badge badge-warn"> older version</span>}
      </p>
      {sections.map((s) => (
        <section key={s.anchor} id={s.anchor} className={s.anchor === target ? "source-section target" : "source-section"}>
          <h2>{s.section}</h2>
          {s.injection_flag && <p className="badge badge-alert">This passage contains text aimed at an AI assistant. The assistant treats it as data and ignores it.</p>}
          <p className="source-text">{s.text}</p>
        </section>
      ))}
    </article>
  );
}
