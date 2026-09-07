import { extname, resolve, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const immutableAsset = /^assets\/.+-[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9]+$/;
const notFound = () => Response.json({ error: "Not found." }, { status: 404, headers: { "Cache-Control": "no-store" } });

async function existingFile(root: string, relative: string) {
  try {
    const path = await realpath(resolve(root, relative));
    if (path !== root && !path.startsWith(root + sep)) return null;
    if (!(await stat(path)).isFile()) return null;
    return path;
  } catch {
    return null;
  }
}

/** Serve only a built Vite directory. API routes and unsupported methods remain API concerns. */
export async function serveStaticWeb(request: Request, webDist?: string): Promise<Response | null> {
  if (!webDist || !["GET", "HEAD"].includes(request.method)) return null;
  const url = new URL(request.url);
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { return notFound(); }
  if (pathname === "/api" || pathname.startsWith("/api/") || pathname.includes("\\") || pathname.includes("\0")) return null;
  const segments = pathname.split("/");
  if (segments.some(segment => segment === "." || segment === ".." || segment.startsWith("."))) return notFound();

  let root: string;
  try { root = await realpath(resolve(webDist)); }
  catch { return null; }
  const requested = segments.filter(Boolean).join("/");
  let relative = requested || "index.html";
  let path = await existingFile(root, relative);
  if (!path) {
    if (requested.startsWith("assets/") || extname(requested)) return notFound();
    relative = "index.html";
    path = await existingFile(root, relative);
  }
  if (!path) return null;

  const file = Bun.file(path);
  const headers = new Headers({
    "Cache-Control": immutableAsset.test(relative) ? "public, max-age=31536000, immutable" : "no-cache",
    "Content-Length": String(file.size),
    "Content-Type": MIME_TYPES[extname(relative).toLowerCase()] ?? "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });
  return new Response(request.method === "HEAD" ? null : file.stream(), { headers });
}
