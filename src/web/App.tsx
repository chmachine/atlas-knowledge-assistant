import { useEffect, useState } from "react";
import { api, type User } from "./api";
import { Audit } from "./Audit";
import { Chat } from "./Chat";
import { Dashboard } from "./Dashboard";
import { Login } from "./Login";
import { roleLabel } from "./labels";
import { Source } from "./Source";

type Session = { status: "loading" } | { status: "anon" } | { status: "user"; user: User };

export function App() {
  const [session, setSession] = useState<Session>({ status: "loading" });

  useEffect(() => {
    api<{ user: User }>("/api/auth/me")
      .then((r) => setSession({ status: "user", user: r.user }))
      .catch(() => setSession({ status: "anon" })); // 401, or the API is unreachable: show the sign-in screen
  }, []);

  async function signOut() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    setSession({ status: "anon" });
    if (location.pathname !== "/") history.replaceState(null, "", "/");
  }

  if (session.status === "loading") {
    return (
      <main className="shell">
        <p className="muted">Loading…</p>
      </main>
    );
  }
  if (session.status === "anon") return <Login onLogin={(user) => setSession({ status: "user", user })} />;

  const { user } = session;
  const source = /^\/source\/([^/]+)$/.exec(location.pathname);
  const onAudit = location.pathname === "/admin/audit";
  const onDashboard = location.pathname === "/admin/dashboard";
  const adminOnly = <p role="alert" className="error">This page is for the Admin role only.</p>;
  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <a className="brand" href="/">
            Atlas Knowledge Assistant
          </a>
          <span className="muted"> · {user.display_name}</span>
        </div>
        <div className="topbar-right">
          {user.is_admin && <a className="link" href="/admin/dashboard">Dashboard</a>}
          {user.is_admin && <a className="link" href="/admin/audit">Audit log</a>}
          <span className="chip chip-strong" title={`Can read: ${user.sees.join(", ")}`}>
            {roleLabel(user)}
          </span>
          <button className="link" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      {onDashboard ? (user.is_admin ? <Dashboard /> : adminOnly) : onAudit ? (user.is_admin ? <Audit /> : adminOnly) : source ? <Source docId={decodeURIComponent(source[1]!)} /> : <Chat user={user} />}
    </main>
  );
}
