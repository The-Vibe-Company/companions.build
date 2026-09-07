import { test, expect, spyOn } from "bun:test";
import { BoxClient } from "../../../packages/box/client";
import { fetchAgent } from "../../../packages/box/transport";
test("Box creation is isolated, templated and idempotent", async () => {
  let request: RequestInit | undefined;
  const client = new BoxClient("synthetic-secret", (async (_url: any, init: any) => {
    request = init; return Response.json({ ok: true, box: { id: "box-1", state: "provisioning" } }, { status: 202 });
  }) as typeof fetch);
  expect(await client.create("unique-key", "frozen-template")).toEqual({ id: "box-1", state: "provisioning", setupStatus: undefined });
  expect(JSON.parse(request!.body as string)).toMatchObject({ noEnv: true, from: "frozen-template" });
  expect((request!.headers as any)["Idempotency-Key"]).toBe("unique-key");
});
test("provider errors never expose raw credentials or response bodies", async () => {
  const client = new BoxClient("secret", (async () => new Response("provider secret token", { status: 500 })) as any);
  await expect(client.get("box-1")).rejects.toThrow("box_request_failed");
});
test("private preview gate preserves the request through its cookie exchange", async () => {
  const calls: any[] = [];
  const fetcher = (async (url: any, init: any) => {
    calls.push({ url: String(url), method: init.method, headers: new Headers(init.headers), body: init.body });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: "/runs/id", "set-cookie": "_port_auth=synthetic; HttpOnly; Path=/" } }) : Response.json({ accepted: true });
  }) as typeof fetch;
  const response = await fetchAgent("https://test.on.ascii.dev?_token=synthetic", "daemon-secret", "/runs/id", "PUT", { content: "Hello" }, 10_000, fetcher);
  expect(response.ok).toBe(true);
  expect(calls[1].method).toBe("PUT");
  expect(calls[1].body).toBe(calls[0].body);
  expect(calls[1].headers.get("cookie")).toBe("_port_auth=synthetic");
  expect(calls[1].headers.get("authorization")).toBe("Bearer daemon-secret");
});
test("private preview redirects cannot forward credentials to another origin", async () => {
  let calls = 0;
  await expect(fetchAgent("https://test.on.ascii.dev?_token=synthetic", "daemon-secret", "/health", "GET", undefined,
    10_000, (async () => { calls++; return new Response(null, { status: 302, headers: { location: "https://other.invalid/" } }); }) as any)).rejects.toThrow("agent_cross_origin_redirect");
  expect(calls).toBe(1);
});
test("private preview cookie exchange merges cookies across redirects", async () => {
  const calls: any[] = [];
  const fetcher = (async (url: any, init: any) => {
    calls.push({ url: String(url), headers: new Headers(init.headers) });
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: "/health", "set-cookie": "_port_auth=first; HttpOnly; Path=/" } });
    if (calls.length === 2) return new Response(null, { status: 302, headers: { location: "/health", "set-cookie": "preview_nonce=second; HttpOnly; Path=/" } });
    return Response.json({ ready: true });
  }) as typeof fetch;
  const response = await fetchAgent("https://test.on.ascii.dev?_token=synthetic", "daemon-secret", "/health", "GET", undefined, 10_000, fetcher);
  expect(response.ok).toBe(true);
  expect(calls[2].headers.get("cookie")).toBe("_port_auth=first; preview_nonce=second");
});
test("private preview redirects cannot replay a mutation to another path", async () => {
  let calls = 0;
  await expect(fetchAgent("https://test.on.ascii.dev?_token=synthetic", "daemon-secret", "/runs/id", "PUT", { content: "Hello" },
    10_000, (async () => { calls++; return new Response(null, { status: 302, headers: { location: "/runs/other" } }); }) as any)).rejects.toThrow("agent_cross_path_redirect");
  expect(calls).toBe(1);
});
test("private preview transport preserves request query parameters alongside its access token",async()=>{
 let observed:URL|undefined;
 await fetchAgent('https://test.on.ascii.dev?_token=synthetic','daemon-secret','/files/outbox?runId=example','GET',undefined,1000,(async(url:any)=>{observed=new URL(url);return Response.json({files:[]});}) as any);
 expect(observed!.pathname).toBe('/files/outbox');expect(observed!.searchParams.get('runId')).toBe('example');expect(observed!.searchParams.get('_token')).toBe('synthetic');
});


test("snapshot refusals expose only the known recoverable codes",async()=>{
 for(const [code,expected] of [["named_snapshot_limit","box_snapshot_limit"],["save_in_progress","box_snapshot_saving"],["unknown-provider-secret","box_request_failed"]]){
  const client=new BoxClient("test-only",(async()=>Response.json({code,message:"provider-private-payload"},{status:409})) as unknown as typeof fetch);
  await expect(client.snapshot("owned-build","immutable-release")).rejects.toThrow(expected);
 }
});


test("preparation reuses an interactive Box in ready, idle, or running state",async()=>{
 const {prepareBox,environmentDigest}=await import('../src/machines');
 const {config,encrypt}=await import('../src/config');
 const previous=config.boxTemplate;config.boxTemplate='test-frozen-template';
 try{
  for(const state of ['ready','idle','running']){
   let calls=0;
   const client=new BoxClient('test-only',(async()=>{calls++;return Response.json({box:{id:'owned-box',state,setupStatus:'done'}});}) as unknown as typeof fetch);
   const secret=encrypt('test-daemon');
   const endpoint=await prepareBox({box_id:'owned-box',agent_secret:secret,endpoint_secret:encrypt('https://private.invalid'),config_digest:environmentDigest(secret)},async()=>{throw Error('unexpected create');},async()=>{throw Error('unexpected configuration');},async()=>{},client);
   expect(endpoint).toBe('https://private.invalid');expect(calls).toBe(1);
  }
 }finally{config.boxTemplate=previous;}
});

test("Box service tracing keeps one guarded command and reports its internal phases",async()=>{
 const {prepareBox}=await import('../src/machines');
 const {config,encrypt}=await import('../src/config');
 const previousTemplate=config.boxTemplate,previousTrace=process.env.COMPANIONS_TRACE_PREPARATION;
 config.boxTemplate='test-frozen-template';process.env.COMPANIONS_TRACE_PREPARATION='1';
 const calls:string[]=[],lines:string[]=[];let guards=0,configured=0;
 const output=spyOn(console,'info').mockImplementation(value=>lines.push(String(value)));
 const client=new BoxClient('test-only',(async(input:URL|RequestInfo,init?:RequestInit)=>{
  const path=new URL(String(input)).pathname,method=init?.method??'GET';calls.push(`${method} ${path}`);
  if(method==='GET')return Response.json({box:{id:'owned-box',state:'ready',setupStatus:'done'}});
  if(path.endsWith('/files'))return Response.json({success:true});
  const command=JSON.parse(String(init?.body)).command as string;
  if(command.includes('host 8787'))return Response.json({success:true,exitCode:0,stdout:'https://fixture.on.ascii.dev?_token=test'});
  expect(command).toContain('trace_service desktop');expect(command).toContain('trace_service agent');expect(command).toContain('trace_service proxy');
  return Response.json({success:true,exitCode:0,stdout:[
   '__COMPANIONS_SERVICE_PHASE__ desktop 1000000000 1300000000 0',
   '__COMPANIONS_SERVICE_PHASE__ agent 1300000000 1800000000 0',
   '__COMPANIONS_SERVICE_PHASE__ proxy 1800000000 1900000000 0',
  ].join('\n')});
 }) as typeof fetch);
 try{
  const endpoint=await prepareBox({id:'11111111-1111-4111-8111-111111111111',box_id:'owned-box',agent_secret:encrypt('test-daemon'),endpoint_secret:null,config_digest:null},async()=>{},async()=>{configured++;},async()=>{guards++;},client);
  expect(endpoint).toBe('https://fixture.on.ascii.dev/?_token=test');
  expect(guards).toBe(5);expect(configured).toBe(1);
  expect(calls).toEqual(['GET /api/box/v1/boxes/owned-box','PUT /api/box/v1/boxes/owned-box/files','POST /api/box/v1/boxes/owned-box/commands','POST /api/box/v1/boxes/owned-box/commands']);
  const events=lines.map(line=>JSON.parse(line)).filter(event=>event.event==='preparation_trace');
  expect(events.filter(event=>event.phase.startsWith('box_service_')).map(event=>[event.phase,event.durationMs])).toEqual([
   ['box_service_desktop',300],['box_service_agent',500],['box_service_proxy',100],
  ]);
 }finally{
  output.mockRestore();config.boxTemplate=previousTemplate;
  if(previousTrace===undefined)delete process.env.COMPANIONS_TRACE_PREPARATION;else process.env.COMPANIONS_TRACE_PREPARATION=previousTrace;
 }
});


test("desktop access stays private and only explicit provisioning remains pending", async () => {
  const replies = [
    { ok: true, provisioning: true },
    { ok: true, success: false, provisioning: true, desktopUrl: null },
    { ok: true, success: true, desktopUrl: "https://fixture.on.ascii.dev/vnc.html?_token=synthetic" },
  ];
  const calls: any[] = [];
  const client = new BoxClient("synthetic-secret", (async (_url: any, init: any) => {
    calls.push(JSON.parse(init.body)); return Response.json(replies.shift());
  }) as typeof fetch);
  await expect(client.desktop("owned-box")).rejects.toThrow("desktop_preparing");
  await expect(client.desktop("owned-box")).rejects.toThrow("desktop_preparing");
  expect(await client.desktop("owned-box")).toBe("https://fixture.on.ascii.dev/vnc.html?_token=synthetic");
  expect(calls).toEqual([{ publicAccess: false }, { publicAccess: false }, { publicAccess: false }]);
});

test("invalid desktop provider replies fail visibly without leaking payloads or pretending to prepare", async () => {
  for (const reply of [null, {}, { success: false }, { provisioning: "true" },
    { success: true }, { success: true, desktopUrl: "provider-private-payload" },
    { success: true, desktopUrl: "https://fixture.invalid/vnc.html" },
    { success: true, desktopUrl: "https://fixture.invalid/vnc.html?_token=" },
    { success: true, desktopUrl: "http://fixture.invalid/?_token=private" },
    { success: true, desktopUrl: "https://user:private@fixture.invalid/" },
    { success: true, provisioning: true, desktopUrl: "https://fixture.invalid/" },
  ]) {
    const client = new BoxClient("synthetic-secret", (async () => Response.json(reply)) as unknown as typeof fetch);
    await expect(client.desktop("owned-box")).rejects.toThrow("desktop_invalid");
  }
});
