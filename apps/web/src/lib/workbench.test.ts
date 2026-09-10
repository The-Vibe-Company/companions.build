// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { composeModules, designSkill, profiles, resolveProfile } from "../../../../packages/workbench/profiles";
import { artifactPublicationSchema, artifactRevisionSchema, parseWorkbenchEvent } from "../../../../packages/workbench/artifacts";
import { composeDesignContext, designSkillPack } from "../../../../packages/workbench/skill-context";

const companionId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const provenance = { companionId, runId, conversation: { kind: "main", id: companionId }, profileId: "design-v1", skill: designSkill };
const manifest = { schemaVersion: 1, artifactId: crypto.randomUUID(), revisionId: crypto.randomUUID(), revision: 1, previousRevisionId: null, title: "Landing page", kind: "static-html", renderer: "sandboxed-html-v1", status: "ready", failureCode: null, source: { workspacePath: "artifacts/landing/rev-1.html", sha256: "a".repeat(64) }, provenance, createdAt: new Date().toISOString() };

describe("workbench contracts", () => {
  it("resolves legacy and unknown profiles conservatively without mutating their identity", () => {
    const legacy = { name: "Design" };
    expect(resolveProfile()).toBe(profiles["default-v1"]);
    expect(resolveProfile(null)).toBe(profiles["default-v1"]);
    expect(resolveProfile("future-v9")).toBe(profiles["default-v1"]);
    expect(legacy).toEqual({ name: "Design" });
    expect(composeModules(null).map(module => module.id)).toEqual(["chat"]);
    expect(composeModules("design-v1").map(module => module.id)).toEqual(["chat", "artifact-preview", "artifact-history", "assets", "design-brief"]);
  });
  it("requires bounded, complete provenance and separates failed attempts from valid snapshots", () => {
    expect(artifactPublicationSchema.safeParse({ manifest, html: "<h1>Design</h1>" }).success).toBe(true);
    for (const changed of [
      { provenance: { ...provenance, runId: undefined } }, { provenance: { ...provenance, skill: { ...designSkill, version: "latest" } } },
      { kind: "live-url" }, { renderer: "react" }, { revision: 2 }, { status: "failed" },
      { source: { ...manifest.source, workspacePath: "artifacts/../../private" } },
    ]) expect(artifactRevisionSchema.safeParse({ ...manifest, ...changed }).success).toBe(false);
    expect(artifactPublicationSchema.safeParse({ manifest, html: null }).success).toBe(false);
    expect(artifactPublicationSchema.safeParse({ manifest, html: "a".repeat(256_001) }).success).toBe(false);
    expect(artifactPublicationSchema.safeParse({ manifest: { ...manifest, status: "failed", failureCode: "render_failed" }, html: null }).success).toBe(true);
  });
  it("accepts only typed events selecting first-party modules, with stable provenance", () => {
    const event = { id: crypto.randomUUID(), type: "workbench.open", moduleId: "artifact-preview", provenance, createdAt: new Date().toISOString() };
    expect(parseWorkbenchEvent(event)).toEqual(event);
    expect(parseWorkbenchEvent({ ...event, moduleId: "downloaded-ui" })).toBeNull();
    expect(parseWorkbenchEvent({ ...event, component: "<script>arbitrary code</script>" })).toBeNull();
    expect(parseWorkbenchEvent("Open the preview please")).toBeNull();
  });
  it("pins the staged pack contents and composes task references separately from skill instructions", () => {
    for (const file of designSkillPack.files) {
      const content = readFileSync(new URL(`../../../../packages/workbench/skills/design-foundation/1.0.0/${file.path}`, import.meta.url));
      expect(createHash("sha256").update(content).digest("hex")).toBe(file.sha256);
    }
    const input = { companionId, runId, conversation: { kind: "main" as const, id: companionId }, brief: "Build an editorial site", designSystem: { id: "brand", revision: "3", workspacePath: "references/brand.md", sha256: "b".repeat(64) } };
    const plan = composeDesignContext(input);
    expect(plan.sections.map(section => section.kind)).toEqual(["brief", "design-system", "references", "assets", "skill"]);
    expect(plan.activation).toBe("staged");
    expect(plan.skill).toEqual(profiles["design-v1"].skills[0]);
    expect(composeDesignContext(input)).toEqual(plan);
    expect(() => composeDesignContext({ ...input, assets: [{ ...input.designSystem, workspacePath: "../secret" }] })).toThrow();
  });
});
