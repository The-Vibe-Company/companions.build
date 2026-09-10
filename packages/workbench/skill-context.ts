import { z } from "zod";
import { conversationSchema } from "./artifacts";
import { designSkill } from "./profiles";
import manifest from "./skills/design-foundation/1.0.0/manifest.json";

/** Packaged in source for this slice. Activation/staging into agent distributions is a separate rollout. */
export const designSkillPack = { ...manifest, ...designSkill, status: "staged" as const };
const referenceSchema = z.object({
  id: z.string().min(1).max(160), revision: z.string().min(1).max(100),
  workspacePath: z.string().min(1).max(500).refine(path => path.split("/").every(part => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== "." && part !== "..")),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const contextInputSchema = z.object({
  companionId: z.uuid(), runId: z.uuid(), conversation: conversationSchema,
  brief: z.string().max(20_000), designSystem: referenceSchema.optional(),
  references: z.array(referenceSchema).max(20).default([]), assets: z.array(referenceSchema).max(50).default([]),
}).strict();
export type DesignContextInput = z.input<typeof contextInputSchema>;

/** A deterministic, run-scoped composition plan, not a replacement for Pi's context or transcript. */
export function composeDesignContext(input: DesignContextInput) {
  const value = contextInputSchema.parse(input);
  return {
    version: 1 as const, profileId: "design-v1" as const,
    companionId: value.companionId, runId: value.runId, conversation: value.conversation,
    skill: designSkill, activation: designSkillPack.status,
    // A future executor must validate file digests and stage only these references before dispatch.
    sections: [
      { kind: "brief" as const, text: value.brief },
      ...(value.designSystem ? [{ kind: "design-system" as const, reference: value.designSystem }] : []),
      { kind: "references" as const, references: value.references },
      { kind: "assets" as const, references: value.assets },
      { kind: "skill" as const, pack: designSkillPack },
    ],
  };
}
