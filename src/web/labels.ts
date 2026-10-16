import type { User } from "./api";

export const LABEL_NAMES: Record<string, string> = {
  general: "General",
  it: "IT",
  security: "Security",
  hr: "HR",
  finance: "Finance",
};

/** Card title per demo username (usernames equal the role names; the admin is a separate card). */
export const DEMO_TITLES: Record<string, { title: string; blurb: string }> = {
  employee: { title: "Employee", blurb: "Everyday company documents" },
  it_ops: { title: "IT Ops", blurb: "Plus IT runbooks and security policy" },
  hr: { title: "HR", blurb: "Plus HR policies" },
  finance: { title: "Finance", blurb: "Plus finance procedures" },
  admin: { title: "Admin", blurb: "Audit log and adoption dashboard" },
};

export const roleLabel = (user: Pick<User, "username" | "role">) =>
  DEMO_TITLES[user.username]?.title ?? LABEL_NAMES[user.role] ?? user.role;
