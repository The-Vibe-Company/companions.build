const PROVIDER_API_KEYS: Record<string, string[]> = {
  "ant-ling": ["ANT_LING_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"],
  "azure-openai-responses": ["AZURE_OPENAI_API_KEY"],
  baseten: ["BASETEN_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  "cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY"],
  "cloudflare-workers-ai": ["CLOUDFLARE_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  "github-copilot": ["COPILOT_GITHUB_TOKEN"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  "google-vertex": ["GOOGLE_CLOUD_API_KEY"],
  groq: ["GROQ_API_KEY"],
  huggingface: ["HF_TOKEN"],
  "kimi-coding": ["KIMI_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_CN_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  "moonshotai-cn": ["MOONSHOT_API_KEY"],
  nvidia: ["NVIDIA_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  opencode: ["OPENCODE_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "qwen-token-plan": ["QWEN_TOKEN_PLAN_API_KEY"],
  "qwen-token-plan-cn": ["QWEN_TOKEN_PLAN_CN_API_KEY"],
  "qwen-token-plan-individual": ["QWEN_TOKEN_PLAN_API_KEY"],
  radius: ["RADIUS_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  xai: ["XAI_API_KEY"],
  xiaomi: ["XIAOMI_API_KEY"],
  "xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
  "xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
  "xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
  zai: ["ZAI_API_KEY"],
  "zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
};

const EXTRA_SECRET_NAMES = [
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK",
];

export function takeAgentToken(): string {
  const token = process.env.AGENT_TOKEN?.trim();
  delete process.env.AGENT_TOKEN;
  if (!token) throw new Error("MISSING_AGENT_TOKEN");
  return token;
}

export function takeProviderApiKey(provider: string): string | undefined {
  const selectedNames = PROVIDER_API_KEYS[provider] ?? [];
  const value = selectedNames.map(name => process.env[name]?.trim()).find(Boolean);
  // This prevents normal Pi shell children from inheriting control/model secrets. It is not an
  // isolation boundary against malicious same-user or root inspection of daemon memory/processes;
  // the Box or container remains that trust boundary.
  clearProviderSecrets();
  return value;
}

export function clearProviderSecrets(): void {
  for (const name of new Set([...Object.values(PROVIDER_API_KEYS).flat(), ...EXTRA_SECRET_NAMES])) delete process.env[name];
}

export const providerSecretEnvironmentNames = Object.freeze([
  ...new Set([...Object.values(PROVIDER_API_KEYS).flat(), ...EXTRA_SECRET_NAMES]),
]);
