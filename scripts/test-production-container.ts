import { randomBytes } from "node:crypto";

const id = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const label = `companions.build.container-test=${id}`;
const image = `companions-build-test:${id}`;
const network = `companions-build-test-${id}`;
const postgres = `companions-build-test-pg-${id}`;
const api = `companions-build-test-api-${id}`;
const processEnv = {
  ...process.env,
  DATABASE_URL: "postgres://companions:companions@postgres:5432/companions",
  APP_URL: "http://127.0.0.1:3000",
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  COMPANIONS_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
};

async function run(args: string[], options: { quiet?: boolean; allowFailure?: boolean } = {}) {
  const child = Bun.spawn(args, { env: processEnv, stdout: options.quiet ? "pipe" : "inherit", stderr: options.quiet ? "pipe" : "inherit" });
  const code = await child.exited;
  if (code && !options.allowFailure) {
    const error = options.quiet ? await new Response(child.stderr).text() : "";
    throw new Error(`${args[0]} failed (${code})${error ? `: ${error.trim()}` : ""}`);
  }
  return { code, stdout: options.quiet ? (await new Response(child.stdout).text()).trim() : "" };
}

async function request(path: string, init?: RequestInit) {
  return fetch(`http://127.0.0.1:${port}${path}`, init);
}

let port = "";
try {
  await run(["docker", "build", "--tag", image, "."]);
  const dockerCli = await run(["docker", "run", "--rm", "--entrypoint", "sh", image, "-c", "command -v docker"], { quiet: true, allowFailure: true });
  if (dockerCli.code === 0) throw new Error("Production image still includes the Docker CLI");
  await run(["docker", "network", "create", "--label", label, network], { quiet: true });
  await run(["docker", "run", "--detach", "--name", postgres, "--network", network, "--network-alias", "postgres", "--label", label,
    "--env", "POSTGRES_USER=companions", "--env", "POSTGRES_PASSWORD=companions", "--env", "POSTGRES_DB=companions",
    "postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"], { quiet: true });
  for (let attempt = 0; attempt < 60; attempt++) {
    const ready = await run(["docker", "exec", postgres, "pg_isready", "-U", "companions"], { quiet: true, allowFailure: true });
    if (!ready.code) break;
    if (attempt === 59) throw new Error("PostgreSQL readiness timed out");
    await Bun.sleep(250);
  }
  const shared = ["--env", "DATABASE_URL", "--env", "APP_URL", "--env", "BETTER_AUTH_SECRET", "--env", "COMPANIONS_ENCRYPTION_KEY"];
  await run(["docker", "run", "--rm", "--network", network, ...shared, image, "migrate"]);
  await run(["docker", "run", "--detach", "--name", api, "--network", network, "--label", label, "--publish", "127.0.0.1::3000", ...shared, image, "api"], { quiet: true });
  const mapping = await run(["docker", "port", api, "3000/tcp"], { quiet: true });
  port = mapping.stdout.split(":").at(-1) ?? "";
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await request("/health")).status === 200) break; } catch { /* starting */ }
    if (attempt === 59) throw new Error("API readiness timed out");
    await Bun.sleep(250);
  }

  const health = await request("/health");
  if (health.status !== 200 || !(await health.json() as any).ok) throw new Error("Health route failed");
  const index = await request("/");
  const html = await index.text();
  if (index.status !== 200 || !index.headers.get("content-type")?.startsWith("text/html") || !html.includes("id=\"root\"")) throw new Error("Built web entry failed");
  const assetPath = html.match(/(?:src|href)="(\/assets\/[^\"]+)"/)?.[1];
  if (!assetPath) throw new Error("Built asset path absent");
  const asset = await request(assetPath);
  if (asset.status !== 200 || asset.headers.get("cache-control") !== "public, max-age=31536000, immutable") throw new Error("Hashed asset caching failed");
  const head = await request(assetPath, { method: "HEAD" });
  if (head.status !== 200 || (await head.text()) !== "") throw new Error("Static HEAD failed");
  if ((await request("/companions/example")).status !== 200) throw new Error("SPA fallback failed");
  const missing = await request("/assets/missing.js");
  if (missing.status !== 404 || !missing.headers.get("content-type")?.startsWith("application/json")) throw new Error("Missing asset boundary failed");
  const unauthenticated = await request("/api/me");
  if (unauthenticated.status !== 401 || unauthenticated.headers.get("cache-control") !== "no-store") throw new Error("API authentication boundary failed");
  const eventBoundary = await request("/api/companions/00000000-0000-4000-8000-000000000001/events");
  if (eventBoundary.status !== 401 || !eventBoundary.headers.get("content-type")?.startsWith("application/json")) throw new Error("Event-stream authentication boundary failed");
  console.log("Production container served the built web app with health/auth boundaries.");
} finally {
  await run(["docker", "container", "remove", "--force", api, postgres], { quiet: true, allowFailure: true });
  await run(["docker", "network", "remove", network], { quiet: true, allowFailure: true });
  await run(["docker", "image", "remove", "--force", image], { quiet: true, allowFailure: true });
}
