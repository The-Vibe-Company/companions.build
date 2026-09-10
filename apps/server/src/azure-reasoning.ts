const efforts=['none','minimal','low','medium','high','xhigh'] as const;
export type AzureReasoningOverride={model:string;effort:typeof efforts[number]};

/** API policy applies to new requests, including requests from existing agent sessions. */
export function azureReasoningOverride(env:Record<string,string|undefined>=process.env):AzureReasoningOverride|undefined{
 const model=env.AZURE_OPENAI_REASONING_MODEL?.trim(),effort=env.AZURE_OPENAI_REASONING_EFFORT?.trim();
 if(!model&&!effort)return undefined;
 if(!model||!efforts.includes(effort as typeof efforts[number]))throw Error('AZURE_OPENAI_REASONING_OVERRIDE_INVALID');
 return {model,effort:effort as typeof efforts[number]};
}
