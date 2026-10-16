import { describe, expect, it } from "vitest";
import { ACCESS_LABELS, ROLES, allowedLabels, canAccess, isRole } from "../src/worker/access/policy";

// Mandatory tests: the permission model is the heart of the governance story.

describe("access policy: which labels each role may read", () => {
  it("maps every role to exactly the labels in the brief", () => {
    expect([...allowedLabels("employee")]).toEqual(["general"]);
    expect([...allowedLabels("it_ops")]).toEqual(["general", "it", "security"]);
    expect([...allowedLabels("hr")]).toEqual(["general", "hr"]);
    expect([...allowedLabels("finance")]).toEqual(["general", "finance"]);
  });

  it("every role can read general documents", () => {
    for (const role of ROLES) expect(canAccess(role, "general")).toBe(true);
  });

  it("each department label is readable only by its own role", () => {
    const readers = (label: string) => ROLES.filter((r) => canAccess(r, label));
    expect(readers("hr")).toEqual(["hr"]);
    expect(readers("finance")).toEqual(["finance"]);
    expect(readers("it")).toEqual(["it_ops"]);
    expect(readers("security")).toEqual(["it_ops"]);
  });

  it("employee cannot read any non-general label", () => {
    for (const label of ACCESS_LABELS.filter((l) => l !== "general")) expect(canAccess("employee", label)).toBe(false);
  });

  it("hr cannot read finance, it or security; finance cannot read hr; it_ops cannot read hr or finance", () => {
    for (const label of ["finance", "it", "security"]) expect(canAccess("hr", label)).toBe(false);
    expect(canAccess("finance", "hr")).toBe(false);
    for (const label of ["hr", "finance"]) expect(canAccess("it_ops", label)).toBe(false);
  });

  it("denies by default: unknown roles get nothing", () => {
    for (const role of ["", "admin", "HR", "root", "__proto__", "constructor", "toString", "hr "]) {
      expect(allowedLabels(role)).toEqual([]);
      expect(canAccess(role, "general")).toBe(false);
    }
  });

  it("denies unknown labels, even for a valid role (labels are case-sensitive)", () => {
    for (const label of ["", "HR", "Hr", "secret", "general ", "*"]) expect(canAccess("hr", label)).toBe(false);
  });

  it("isRole accepts only the four roles", () => {
    for (const role of ROLES) expect(isRole(role)).toBe(true);
    for (const v of ["admin", "", null, undefined, 1, {}, ["hr"]]) expect(isRole(v)).toBe(false);
  });
});
