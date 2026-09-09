import { z } from "zod";
import { db } from "./store";
import { decrypt } from "./config";
import { agentRequest } from "./machines";

// Strip unexpected runtime fields before crossing the browser boundary.
const metadata = z.object({
  enabled: z.boolean(),
  skills: z.array(z.object({ name: z.string(), description: z.string(), source: z.string().optional() })),
});

export async function companionSkillCommands(ownerId: string, id: string): Promise<Response> {
  const [companion] = await db`SELECT endpoint_secret,agent_secret,status FROM companions
    WHERE id=${id} AND owner_id=${ownerId} AND retired_at IS NULL AND archive_requested_at IS NULL`;
  if (!companion) return Response.json({ error: "Companion not found." }, { status: 404 });
  try {
    // This read never wakes a machine or changes its persisted lifecycle.
    if (companion.status !== "ready" || !companion.endpoint_secret) throw new Error("UNAVAILABLE");
    const result = metadata.parse(await agentRequest(decrypt(companion.endpoint_secret), decrypt(companion.agent_secret), "/skill-commands"));
    return Response.json({ ...result, skills: result.enabled ? result.skills : [] }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "Skills are temporarily unavailable." }, { status: 503 });
  }
}
