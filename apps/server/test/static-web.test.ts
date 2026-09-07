import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveStaticWeb } from "../src/static-web";

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "companions-web-dist-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<!doctype html><main>Companions UI</main>");
  await writeFile(join(root, "assets", "index-AbCd1234.js"), "globalThis.built=true");
  await writeFile(join(root, "plain.txt"), "plain");
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

test("built web assets use safe MIME and immutable caching only for hashed files", async () => {
  const asset = await serveStaticWeb(new Request("http://app.test/assets/index-AbCd1234.js"), root);
  expect(asset?.status).toBe(200);
  expect(asset?.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect(asset?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(asset?.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await asset?.text()).toBe("globalThis.built=true");

  const plain = await serveStaticWeb(new Request("http://app.test/plain.txt"), root);
  expect(plain?.headers.get("cache-control")).toBe("no-cache");
  expect(plain?.headers.get("content-type")).toBe("text/plain; charset=utf-8");
});

test("SPA fallback is limited to safe non-API GET and HEAD requests", async () => {
  const route = await serveStaticWeb(new Request("http://app.test/companions/fixture"), root);
  expect(route?.status).toBe(200);
  expect(await route?.text()).toContain("Companions UI");
  expect(route?.headers.get("cache-control")).toBe("no-cache");

  const head = await serveStaticWeb(new Request("http://app.test/", { method: "HEAD" }), root);
  expect(head?.status).toBe(200);
  expect(head?.headers.get("content-length")).toBe(String("<!doctype html><main>Companions UI</main>".length));
  expect(await head?.text()).toBe("");

  expect(await serveStaticWeb(new Request("http://app.test/api/me"), root)).toBeNull();
  expect(await serveStaticWeb(new Request("http://app.test/", { method: "POST" }), root)).toBeNull();
  expect((await serveStaticWeb(new Request("http://app.test/assets/missing.js"), root))?.status).toBe(404);
  expect((await serveStaticWeb(new Request("http://app.test/%2e%2e%2fsecret"), root))?.status).toBe(404);
  expect((await serveStaticWeb(new Request("http://app.test/.env"), root))?.status).toBe(404);
});


test("public modules load behind a TLS proxy while API origin checks remain enforced", async () => {
  const { handler } = await import("../src/api");
  const { config } = await import("../src/config");
  const previousDist = config.webDist;
  const previousUrl = process.env.APP_URL;
  config.webDist = root;
  process.env.APP_URL = "https://old.up.railway.app";
  try {
    const headers = { origin: "https://companions.build" };
    const asset = await handler(new Request("http://companions.build/assets/index-AbCd1234.js", { headers }));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await asset.text()).toBe("globalThis.built=true");
    for (const path of ["/api/companions", "/api/auth/sign-in/magic-link"]) {
      const response = await handler(new Request(`http://companions.build${path}`, { method: "POST", headers }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Origin not allowed." });
    }
  } finally {
    config.webDist = previousDist;
    if (previousUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousUrl;
  }
});
