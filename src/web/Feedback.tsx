import { useState } from "react";
import { api } from "./api";

type Rating = 1 | -1 | null;

/** Thumbs under an answer. Pressing the active thumb again takes the rating back. */
export function Feedback({ auditId }: { auditId: string }) {
  const [rating, setRating] = useState<Rating>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function rate(next: 1 | -1) {
    setBusy(true);
    setFailed(false);
    try {
      const r = await api<{ feedback: Rating }>("/api/feedback", { method: "POST", body: { auditId, value: rating === next ? 0 : next } });
      setRating(r.feedback);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="feedback" role="group" aria-label="Rate this answer">
      <span className="muted small">Was this answer helpful?</span>
      <button type="button" className="thumb" aria-pressed={rating === 1} aria-label="Helpful" title="Helpful" disabled={busy} onClick={() => rate(1)}>
        👍
      </button>
      <button type="button" className="thumb" aria-pressed={rating === -1} aria-label="Not helpful" title="Not helpful" disabled={busy} onClick={() => rate(-1)}>
        👎
      </button>
      <span className="muted small" aria-live="polite">
        {failed ? "Could not save your rating." : rating ? "Thanks, noted." : ""}
      </span>
    </div>
  );
}
