import type { AppOAuthAdapterId } from "./definitions";

export interface AppOAuthAdapter {
  discovery: "standard" | "resource-only" | "fixed";
  pkce: boolean;
  resourceIndicator: boolean;
  scopeSeparator: " " | ",";
  acceptedTokenTypes: readonly string[];
  authorizationParams?: Readonly<Record<string, string>>;
  validateGrantedScopes?: boolean;
  revokedErrorCode?: string;
  enrichCredential?: "github-identity";
}

const oauthAdapters = {
  standard: {
    discovery: "standard",
    pkce: true,
    resourceIndicator: true,
    scopeSeparator: " ",
    acceptedTokenTypes: ["bearer"],
    revokedErrorCode: "invalid_grant",
  },
  github: {
    discovery: "resource-only",
    pkce: true,
    resourceIndicator: false,
    scopeSeparator: " ",
    acceptedTokenTypes: ["bearer"],
    enrichCredential: "github-identity",
  },
  gmail: {
    discovery: "standard",
    pkce: true,
    resourceIndicator: false,
    scopeSeparator: " ",
    acceptedTokenTypes: ["bearer"],
    authorizationParams: {
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent select_account",
    },
    validateGrantedScopes: true,
    revokedErrorCode: "invalid_grant",
  },
  slack: {
    discovery: "fixed",
    pkce: false,
    resourceIndicator: false,
    scopeSeparator: ",",
    acceptedTokenTypes: ["bearer", "bot"],
  },
} as const satisfies Record<AppOAuthAdapterId, AppOAuthAdapter>;

export function getAppOAuthAdapter(id: AppOAuthAdapterId): AppOAuthAdapter {
  return oauthAdapters[id];
}
