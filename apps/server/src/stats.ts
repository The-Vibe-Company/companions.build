import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "./store";

export async function handleStats(request: Request): Promise<Response> {
  const token = process.env.STATS_TOKEN;
  const authorization = request.headers.get("authorization");
  const supplied = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
  // Hash both inputs to a fixed size before the constant-time comparison.
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const headers = { "Cache-Control": "no-store" };
  if (!token || !supplied || !timingSafeEqual(digest(token), digest(supplied))) {
    return Response.json({ error: "Authentication required." }, { status: 401, headers });
  }
  // Sessions record sign-in/refresh; human messages record activity independently
  // of session refresh cadence. Never count assistant output/background execution.
  const [stats] = await db`
    WITH activity AS (
      SELECT "userId" AS user_id, "updatedAt" AS at FROM "session"
      UNION ALL
      SELECT d.owner_id, m.created_at FROM discussion_messages m
        JOIN discussions d ON d.id=m.discussion_id WHERE m.role='user'
      UNION ALL
      SELECT c.owner_id, m.created_at FROM messages m
        JOIN companions c ON c.id=m.companion_id WHERE m.role='user'
    ), recent AS (
      SELECT user_id, max(at) AS at FROM activity WHERE at >= now()-interval '7 days' GROUP BY user_id
    )
    SELECT count(*)::int AS total_users,
      count(*) FILTER (WHERE u."createdAt" >= now()-interval '1 day')::int AS new_users_1d,
      count(*) FILTER (WHERE u."createdAt" >= now()-interval '7 days')::int AS new_users_7d,
      count(*) FILTER (WHERE r.at >= now()-interval '1 day')::int AS active_users_1d,
      count(*) FILTER (WHERE r.at >= now()-interval '7 days')::int AS active_users_7d
    FROM "user" u LEFT JOIN recent r ON r.user_id=u.id`;
  return Response.json(stats, { headers });
}
