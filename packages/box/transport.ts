/** The Box preview gate exchanges _token for a cookie using a same-origin, same-path redirect. */
export async function fetchAgent(endpoint: string, token: string, path: string, method = "GET", body?: unknown, timeoutMs = 10_000, transport: typeof fetch = fetch) {
  let url = new URL(endpoint);
  url.pathname = path;
  const origin = url.origin;
  const headers = new Headers({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
  const cookies = new Map<string, string>();
  const signal = AbortSignal.timeout(timeoutMs);
  for (let hop = 0; hop < 4; hop++) {
    const response = await transport(url, { method, headers, redirect: "manual", signal,
      body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    const setCookies = response.headers.getSetCookie();
    await response.body?.cancel();
    if (!location) throw new Error("agent_invalid_redirect");
    const next = new URL(location, url);
    if (next.origin !== origin) throw new Error("agent_cross_origin_redirect");
    if (next.pathname !== url.pathname) throw new Error("agent_cross_path_redirect");
    for (const cookie of setCookies) {
      const pair = cookie.split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator > 0) cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
    if (cookies.size) headers.set("Cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    else if (!next.searchParams.has("_token") && url.searchParams.has("_token")) next.searchParams.set("_token", url.searchParams.get("_token")!);
    url = next;
  }
  throw new Error("agent_redirect_limit");
}
