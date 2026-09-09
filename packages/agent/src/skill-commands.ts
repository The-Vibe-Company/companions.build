import { SettingsManager, type ResourceLoader } from "@earendil-works/pi-coding-agent";

/** Shared with session creation: discovery must not introduce different Pi defaults. */
export function runtimeSettings() {
  return SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: false } });
}

export interface SkillCommands {
  enabled: boolean;
  skills: Array<{ name: string; description: string; source?: string }>;
}

/** Pi's explicit-command list includes disable-model-invocation skills.
 * Scope/origin are safe Pi metadata; paths and package URLs can contain credentials.
 */
export function skillCommands(loader: Pick<ResourceLoader, "getSkills">, settings: SettingsManager): SkillCommands {
  const enabled = settings.getEnableSkillCommands();
  return { enabled, skills: enabled ? loader.getSkills().skills.map(skill => ({
    name: skill.name, description: skill.description,
    ...(skill.sourceInfo ? { source: `${skill.sourceInfo.scope} · ${skill.sourceInfo.origin}` } : {}),
  })) : [] };
}
