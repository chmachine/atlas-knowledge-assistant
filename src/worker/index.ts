import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { adminRoutes } from "./admin/routes";
import { answerRoutes } from "./answer/routes";
import { authRoutes } from "./auth/routes";
import { csrfGuard, loadSession } from "./auth/middleware";
import type { AppEnv } from "./env";
import { opsRoutes } from "./ops/routes";
import { securityHeaders } from "./security";
import { defaultServices, type ServicesFactory } from "./services";

/** `services` lets tests replace the model, the embedder and the vector store. Production uses the defaults built from the bindings. */
export function createApp(services: ServicesFactory = defaultServices) {
  const app = new Hono<AppEnv>();

  app.use("*", securityHeaders);

  // All /api traffic: small bodies only (ops endpoints, which carry whole documents, get more), CSRF header on writes,
  // then the session (if any) is resolved.
  app.use("/api/*", (c, next) =>
    bodyLimit({ maxSize: c.req.path.startsWith("/api/ops/") ? 256 * 1024 : 16 * 1024, onError: (ctx) => ctx.json({ error: "payload_too_large" }, 413) })(c, next),
  );
  app.use("/api/*", csrfGuard);
  app.use("/api/*", loadSession);

  app.get("/api/health", (c) => c.json({ ok: true, service: "kb-assistant" }));
  app.route("/api/auth", authRoutes);
  app.route("/api/ops", opsRoutes(services));
  app.route("/api/admin", adminRoutes());
  app.route("/api", answerRoutes(services));

  // Unknown API paths must never fall through to the SPA.
  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

  // Everything else is the React app (static assets, with SPA fallback).
  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

  return app;
}

export const app = createApp();
export default app;
