import type { MiddlewareHandler } from "hono";

/** Headers added to every response, including static assets (the Worker runs first). */
export const SECURITY_HEADERS: Record<string, string> = {
  // Public demo: keep it out of search engines and archives.
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  // Strict by default. Only a local, never-deployed .dev.vars file may set APP_ENV=development,
  // which drops the CSP because Vite's dev server injects an inline script and a websocket.
  const dev = (c.env as { APP_ENV?: string } | undefined)?.APP_ENV === "development";
  // c.header() copes with immutable responses (e.g. the one returned by the ASSETS binding).
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (dev && name === "Content-Security-Policy") continue;
    c.header(name, value);
  }
};
