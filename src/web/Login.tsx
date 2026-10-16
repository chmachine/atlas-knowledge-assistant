import { useEffect, useState } from "react";
import { ApiError, api, type User } from "./api";
import { DEMO_TITLES, LABEL_NAMES } from "./labels";

export function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api<{ users: User[] }>("/api/auth/demo-users")
      .then((r) => setUsers(r.users))
      .catch(() => setError("Could not load the demo users. Please reload the page."));
  }, []);

  async function signIn(username: string) {
    setBusy(username);
    setError(null);
    try {
      const { user } = await api<{ user: User }>("/api/auth/demo", { method: "POST", body: { username } });
      onLogin(user);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 429
          ? "Too many sign-ins from your network. Please try again in an hour."
          : "Sign-in failed. Please try again.",
      );
      setBusy(null);
    }
  }

  return (
    <main className="shell">
      <header className="hero">
        <p className="eyebrow">Public demo · fictional company · no real data</p>
        <h1>Atlas Knowledge Assistant</h1>
        <p className="lead">
          Ask questions about Atlas Logistics' internal documents and get cited answers. What you can see depends on your role, so sign in as
          each one and compare.
        </p>
      </header>

      <section aria-labelledby="pick-role">
        <h2 id="pick-role">Sign in with one click</h2>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <ul className="cards">
          {(users ?? []).map((u) => {
            const info = DEMO_TITLES[u.username];
            return (
              <li key={u.id}>
                <button className="card" onClick={() => signIn(u.username)} disabled={busy !== null} aria-busy={busy === u.username}>
                  <span className="card-title">{info?.title ?? u.role}</span>
                  <span className="card-name">{u.display_name}</span>
                  <span className="card-blurb">{info?.blurb}</span>
                  <span className="chips" aria-label="Documents this role can read">
                    {u.sees.map((label) => (
                      <span key={label} className="chip">
                        {LABEL_NAMES[label] ?? label}
                      </span>
                    ))}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {users === null && !error && <p className="muted">Loading…</p>}
      </section>

      <p className="notice">
        Everything here is invented. Do not type personal data: your questions are stored in an audit log that the Admin role can read, which is
        part of what this demo shows.
      </p>
    </main>
  );
}
