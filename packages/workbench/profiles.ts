/** First-party product contracts. Names and editable instructions never select a profile. */
export type ProfileId = "default-v1" | "design-v1" | "design-v2";
export type ModuleId = "chat" | "artifact-preview" | "artifact-history" | "assets" | "design-brief";
export interface ModuleDescriptor {
  readonly id: ModuleId;
  readonly title: string;
  readonly shortTitle?: string;
  readonly order?: number;
  readonly placement: "central" | "side";
  readonly region: "conversation" | "stage" | "inspector";
}
export interface SkillReference { readonly id: string; readonly version: string }
export interface ProfileDescriptor {
  readonly id: ProfileId;
  readonly title: string;
  readonly description: string;
  readonly selectable?: boolean;
  readonly modules: readonly ModuleId[];
  readonly skills: readonly SkillReference[];
  readonly capabilities: readonly ("workspace-files" | "static-artifact-read" | "design-projects" | "static-artifact-publish")[];
  readonly artifactTypes: readonly "static-html"[];
  readonly runtime: { readonly kind: "pi-linux"; readonly artifactPublication: "unavailable" | "workspace-v1" };
}

export const moduleRegistry: Readonly<Record<ModuleId, ModuleDescriptor>> = {
  chat: { id: "chat", title: "Chat", placement: "central", region: "conversation" },
  "artifact-preview": { id: "artifact-preview", title: "Preview", placement: "side", region: "stage" },
  "artifact-history": { id: "artifact-history", title: "History", order: 2, placement: "side", region: "inspector" },
  assets: { id: "assets", title: "Assets", order: 1, placement: "side", region: "inspector" },
  "design-brief": { id: "design-brief", title: "Design brief", shortTitle: "Brief", order: 0, placement: "side", region: "inspector" },
};

export const designSkill = { id: "first-party/design-foundation", version: "1.0.0" } as const;
export const activeDesignSkill = { id: "first-party/design-studio", version: "1.0.0" } as const;
export const profiles: Readonly<Record<ProfileId, ProfileDescriptor>> = {
  "default-v1": {
    id: "default-v1", title: "General", description: "A flexible Companion for everyday work.",
    modules: ["chat"], skills: [], capabilities: ["workspace-files"], artifactTypes: [],
    runtime: { kind: "pi-linux", artifactPublication: "unavailable" },
  },
  "design-v1": {
    id: "design-v1", title: "Design foundation", selectable: false, description: "A design workbench with a brief, assets and space for previews. Artifact publishing is coming next.",
    modules: ["chat", "artifact-preview", "artifact-history", "assets", "design-brief"],
    skills: [designSkill], capabilities: ["workspace-files", "static-artifact-read"], artifactTypes: ["static-html"],
    runtime: { kind: "pi-linux", artifactPublication: "unavailable" },
  },
  "design-v2": {
    id: "design-v2", title: "Design", description: "Create and refine web designs across projects, with saved briefs, previews and version history.",
    modules: ["chat", "artifact-preview", "artifact-history", "assets", "design-brief"],
    skills: [activeDesignSkill], capabilities: ["workspace-files", "static-artifact-read", "design-projects", "static-artifact-publish"], artifactTypes: ["static-html"],
    runtime: { kind: "pi-linux", artifactPublication: "workspace-v1" },
  },
};

export function isProfileId(value: unknown): value is ProfileId {
  return value === "default-v1" || value === "design-v1" || value === "design-v2";
}

/** Null is a legacy default, not a stored migration or a guessed specialization. */
export function resolveProfile(id?: string | null): ProfileDescriptor {
  return isProfileId(id) ? profiles[id] : profiles["default-v1"];
}

export function composeModules(id?: string | null): readonly ModuleDescriptor[] {
  return resolveProfile(id).modules.map(moduleId => moduleRegistry[moduleId]);
}
