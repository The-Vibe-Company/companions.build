import { COMPANION_PLUGIN_OAUTH_SERVERS } from './oauth';
export const pluginCatalog = Object.entries(COMPANION_PLUGIN_OAUTH_SERVERS).map(([id, server]) => ({
  id, provider: server.provider, name: ({github:'GitHub',linear:'Linear',notion:'Notion',conductor:'Conductor',sentry:'Sentry',slack:'Slack',gmail:'Gmail'} as Record<string,string>)[server.provider],
  transport: server.provider === 'slack' ? 'slack' : 'http', url: server.remoteUrl,
}));
export type MachinePlugin = { id: string; name: string; provider: string; transport: 'http'|'stdio'|'slack'; url?: string; command?: string; args?: string[]; env?: Record<string,string>; headers?: Record<string,string>; allowedTools?: string[] };
