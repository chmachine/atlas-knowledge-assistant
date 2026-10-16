// The one place that decides which documents a role may read.
// Every retrieval path (vector filter, SQL, agent tools) derives its filter from here.
// The role always comes from the server-side session, never from a request body or from model output.

export const ROLES = ["employee", "it_ops", "hr", "finance"] as const;
export type Role = (typeof ROLES)[number];

export const ACCESS_LABELS = ["general", "it", "security", "hr", "finance"] as const;
export type AccessLabel = (typeof ACCESS_LABELS)[number];

const ROLE_LABELS: Record<Role, readonly AccessLabel[]> = {
  employee: ["general"],
  it_ops: ["general", "it", "security"],
  hr: ["general", "hr"],
  finance: ["general", "finance"],
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** Labels a role may read. Deny by default: an unknown role gets nothing. */
export function allowedLabels(role: string): readonly AccessLabel[] {
  return isRole(role) ? ROLE_LABELS[role] : [];
}

export function canAccess(role: string, label: string): boolean {
  return (allowedLabels(role) as readonly string[]).includes(label);
}

/**
 * Vectorize metadata filter for a role. Returns null for a role with no access at all:
 * the caller must then skip the query entirely, never run it unfiltered.
 */
export function vectorFilter(role: string): { access_label: { $in: string[] } } | null {
  const labels = allowedLabels(role);
  return labels.length ? { access_label: { $in: [...labels] } } : null;
}

/** SQL restriction for a column, with bound parameters. Null means no access: return nothing without querying. */
export function sqlLabels(role: string, column = "access_label"): { clause: string; params: string[] } | null {
  const labels = allowedLabels(role);
  if (!labels.length) return null;
  return { clause: `${column} IN (${labels.map(() => "?").join(", ")})`, params: [...labels] };
}
