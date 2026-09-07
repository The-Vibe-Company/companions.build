import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple as anthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as googleGenerativeAI } from "@earendil-works/pi-ai/api/google-generative-ai";
import { streamSimple as openAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as openAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const PROVIDERS = new Set(["google", "anthropic", "openai", "openrouter", "zai"]);
const APIS = new Set<Api>(["google-generative-ai", "anthropic-messages", "openai-completions", "openai-responses"]);
const requestContext = new AsyncLocalStorage<{ runId: string; token: string }>();
type Stream = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
type Streams = Record<"google-generative-ai" | "anthropic-messages" | "openai-completions" | "openai-responses", Stream>;

const nativeStreams: Streams = {
  "google-generative-ai": googleGenerativeAI as Stream,
  "anthropic-messages": anthropicMessages as Stream,
  "openai-completions": openAICompletions as Stream,
  "openai-responses": openAIResponses as Stream,
};

export interface ModelGatewayCredential { token: string }

export function modelGatewayUrl(raw: string, allowHttp = false): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("INVALID_MODEL_GATEWAY_URL"); }
  const localHttp=allowHttp&&url.protocol==="http:"&&["127.0.0.1","localhost","::1","host.docker.internal"].includes(url.hostname);
  if ((url.protocol !== "https:" && !localHttp) || url.username || url.password || url.search || url.hash) {
    throw new Error("INVALID_MODEL_GATEWAY_URL");
  }
  if (url.pathname.replace(/\/$/, "") !== "/api/model-gateway") throw new Error("INVALID_MODEL_GATEWAY_URL");
  url.pathname = "/api/model-gateway";
  return url.toString().replace(/\/$/, "");
}

export function parseModelGatewayCredential(value: unknown): ModelGatewayCredential | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !("token" in value)) return undefined;
  const token = (value as { token?: unknown }).token;
  if (typeof token !== "string" || token.length < 16 || token.length > 4096 || /\s/.test(token)) return undefined;
  return { token };
}

export function withModelGatewayRequest<T>(runId: string, credential: ModelGatewayCredential, body: () => T): T {
  return requestContext.run({ runId, token: credential.token }, body);
}

export function modelGatewayStream(base: string, provider: string, streams: Streams = nativeStreams): Stream {
  return (model, context, options) => {
    const request = requestContext.getStore();
    if (!request) throw new Error("MODEL_GATEWAY_CONTEXT_REQUIRED");
    if (model.provider !== provider || !PROVIDERS.has(model.provider)) throw new Error("MODEL_GATEWAY_PROVIDER_UNSUPPORTED");
    const stream = streams[model.api as keyof Streams];
    if (!stream) throw new Error("MODEL_GATEWAY_API_UNSUPPORTED");
    const requestId = randomUUID();
    return stream({...model,baseUrl:`${base}/${provider}/${model.api}`}, context, {
      ...options,
      apiKey: "gateway-only",
      headers: {
        ...options?.headers,
        "X-Companions-Model-Token": request.token,
        "X-Companions-Run-Id": request.runId,
        "X-Companions-Model-Request-Id": requestId,
      },
    });
  };
}

export async function configureModelGateway(runtime: ModelRuntime, provider: string, rawUrl: string, allowHttp = false): Promise<string> {
  if (!PROVIDERS.has(provider)) throw new Error("MODEL_GATEWAY_PROVIDER_UNSUPPORTED");
  const base = modelGatewayUrl(rawUrl, allowHttp);
  const models = runtime.getModels(provider);
  if (!models.length || models.some(model => !APIS.has(model.api))) throw new Error("MODEL_GATEWAY_API_UNSUPPORTED");
  // The native OpenRouter catalog contains both Anthropic and OpenAI protocols. Intercepting
  // ModelRuntime itself preserves that mixed catalog; a registered extension can override only
  // one provider-level API in Pi 0.85.
  await runtime.setRuntimeApiKey(provider,"gateway-only");
  runtime.streamSimple=modelGatewayStream(base,provider) as typeof runtime.streamSimple;
  return base;
}
