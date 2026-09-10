import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { PiExecutor } from "../../src/pi-executor";
import { AgentDaemon } from "../../src/daemon";
import { pluginTools } from "../../../plugins/tools";
import { PluginJournal } from "../../../plugins/journal";

process.env.AGENT_TEST_MODE = "1";
const state = mkdtempSync(join(tmpdir(), "plugin-pi-"));
const executor = await PiExecutor.create(state, { pluginFailureGraceMs: 60, cleanupTimeoutMs: 200 });
const pluginJournal = new PluginJournal(state);
let mcpCalls=0,closedStreams=0;
const mcp=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  if(request.method!=='POST')return new Response(null,{status:405});
  const message=await request.json() as any;
  if(message.id===undefined)return new Response(null,{status:202});
  let result;
  if(message.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
  else if(message.method==='tools/list')result={tools:[{name:'mutate',inputSchema:{type:'object',properties:{}}}]};
  else {mcpCalls++;return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(': waiting\n\n'));},cancel(){closedStreams++;}}),{headers:{'content-type':'text/event-stream'}});}
  return Response.json({jsonrpc:'2.0',id:message.id,result});
}});
let cancelReached!: () => void, lateReached!: () => void, finishLate!: () => void;
let cancelledSignal: AbortSignal | undefined, lateUpdate: (() => void) | undefined;
const cancelStarted = new Promise<void>(resolve => { cancelReached = resolve; });
const lateStarted = new Promise<void>(resolve => { lateReached = resolve; });
const lateResult = new Promise<void>(resolve => { finishLate = resolve; });
let cleanupRoot:string|undefined,cleanupGate:Promise<void>|undefined;
let cleanupEntered:(()=>void)|undefined,cancelToolEntered:(()=>void)|undefined;

executor.toolsFactory = async context => {
  const plugins=pluginTools(()=>[{id:'fixture',provider:'custom',name:'Fixture',transport:'http',url:`http://127.0.0.1:${mcp.port}/mcp`}],{runId:context.runId,signal:context.signal,onFailure:context.onPluginFailure,journal:pluginJournal,limits:{call:20,operation:500,cleanup:30}});
  const parameters = Type.Object({ mode: Type.Union([Type.Literal("fail"), Type.Literal("cancel"), Type.Literal("late")]) });
  const tool: ToolDefinition<typeof parameters> = {
    name: "fixture_plugin", label: "Fixture plugin", description: "Exercise Pi plugin failure boundaries.",
    parameters,
    async execute(_toolId, params, signal, onUpdate) {
      if (params.mode === "fail") {
        return plugins.tools[1]!.execute(_toolId,{connectionId:'fixture',tool:'mutate',arguments:{}},signal,undefined,{} as never);
      }
      if (params.mode === "cancel") {
        cancelledSignal = signal;
        cancelReached();
        cancelToolEntered?.();
        await new Promise<void>((_resolve, reject) => {
          const stop = () => reject(new Error("fixture-cancelled"));
          signal?.addEventListener("abort", stop, { once: true });
          if (signal?.aborted) stop();
        });
      } else {
        lateUpdate = () => onUpdate?.({ content: [{ type: "text", text: "late update" }], details: {} });
        lateReached();
        await lateResult;
      }
      return { content: [{ type: "text", text: "late success" }], details: {} };
    },
  };
  return { tools: [tool], async close() {
    if(context.runId===cleanupRoot){cleanupEntered?.();await cleanupGate;}
    await plugins.close();
  } };
};

const input = (content: string) => ({ content, instructions: "", lane: "main" as const });
try {
  const explained = await executor.execute(crypto.randomUUID(), input("plugin-runtime-explain"));
  assert.equal(explained.text, "Plugin failure explained.");

  await assert.rejects(
    executor.execute(crypto.randomUUID(), input("plugin-runtime-model-error")),
    error => error instanceof Error && error.message === "PLUGIN_TIMEOUT",
  );

  const progress: string[] = [];
  const hungAt = Date.now();
  await assert.rejects(
    executor.execute(crypto.randomUUID(), input("plugin-runtime-hang"), value => progress.push(value.previewText)),
    error => error instanceof Error && error.message === "PLUGIN_RESPONSE_TIMEOUT",
  );
  assert(Date.now() - hungAt < 1_000);
  assert(progress.some(value => value.includes("Partial explanation only.")));

  const next = await executor.execute(crypto.randomUUID(), input("plugin-runtime-next"));
  assert.equal(next.text, "Next message completed.");

  const cancelId = crypto.randomUUID();
  const cancelled = executor.execute(cancelId, input("plugin-runtime-cancel"));
  const cancelledResult = assert.rejects(cancelled, error => error instanceof Error && error.message === "RUN_CANCELLED");
  await cancelStarted;
  await executor.cancel(cancelId);
  await cancelledResult;
  assert.equal(cancelledSignal?.aborted, true);

  const lateId = crypto.randomUUID();
  let lateProgress = 0;
  const late = executor.execute(lateId, input("plugin-runtime-late"), () => { lateProgress++; });
  const lateRejected = assert.rejects(late, error => error instanceof Error && error.message === "RUN_CANCELLED");
  await lateStarted;
  await executor.cancel(lateId);
  await lateRejected;
  const settledProgress = lateProgress;
  lateUpdate?.();
  finishLate();
  await Bun.sleep(25);
  assert.equal(lateProgress, settledProgress);

  const afterLate = await executor.execute(crypto.randomUUID(), input("plugin-runtime-next"));
  assert.equal(afterLate.text, "Next message completed.");
  // Exercise the durable daemon boundary with the same real Pi and fake MCP.
  const daemon=new AgentDaemon(state,'fixture-token',executor);
  const dispatch=async(id:string,content:string)=>daemon.fetch(new Request(`http://agent/runs/${id}`,{method:'PUT',headers:{Authorization:'Bearer fixture-token'},body:JSON.stringify(input(content))}));
  const terminal=async(id:string)=>{for(let i=0;i<400;i++){const run=daemon.journal.get(id);if(run&&run.status!=='running')return run;await Bun.sleep(5);}throw Error('DAEMON_FIXTURE_TIMEOUT');};
  try{
    const id=crypto.randomUUID();assert.equal((await dispatch(id,'plugin-runtime-hang')).status,202);
    const failed=await terminal(id);
    assert.equal(failed.status,'failed');assert.equal(failed.error,'PLUGIN_RESPONSE_TIMEOUT');
    assert.equal(failed.pluginCalls?.[0]?.outcome,'unknown');assert.equal(failed.pluginCalls?.[0]?.code,'PLUGIN_TIMEOUT');
    assert(failed.messages?.some(message=>message.text.includes('Partial explanation only.')&&!message.complete));
    const callsBefore=mcpCalls;
    const following=crypto.randomUUID();assert.equal((await dispatch(following,'plugin-runtime-next')).status,202);
    assert.equal((await terminal(following)).status,'succeeded');assert.equal(mcpCalls,callsBefore);
    assert.equal((await dispatch(id,'plugin-runtime-hang')).status,200);assert.equal(mcpCalls,callsBefore);
    assert(closedStreams>=4);

    // A non-cooperative close retains admission until the bounded drain ends.
    cleanupRoot=crypto.randomUUID();
    let releaseCleanup!:()=>void;
    cleanupGate=new Promise<void>(resolve=>{releaseCleanup=resolve;});
    const closing=new Promise<void>(resolve=>{cleanupEntered=resolve;});
    const toolEntered=new Promise<void>(resolve=>{cancelToolEntered=resolve;});
    assert.equal((await dispatch(cleanupRoot,'plugin-runtime-cancel')).status,202);
    await toolEntered;
    let cancellationDone=false;
    const started=Date.now();
    const cancellation=daemon.fetch(new Request(`http://agent/runs/${cleanupRoot}/cancel`,{method:'POST',headers:{Authorization:'Bearer fixture-token'}})).then(result=>{cancellationDone=true;return result;});
    await closing;
    assert.equal(cancellationDone,false);
    assert.equal(executor.acceptingRoot('main'),null);
    assert.equal(executor.occupiedRoot('main'),cleanupRoot);
    const afterCleanup=crypto.randomUUID();
    assert.equal((await dispatch(afterCleanup,'plugin-runtime-next')).status,409);
    assert.equal(daemon.journal.get(afterCleanup),null);
    await assert.rejects(executor.execute(crypto.randomUUID(),input('plugin-runtime-next')),/EXECUTOR_BUSY/);
    assert.equal((await cancellation).status,200);
    assert(Date.now()-started<1_000);
    for(let i=0;i<100&&executor.occupiedRoot('main');i++)await Bun.sleep(5);
    assert.equal((await dispatch(afterCleanup,'plugin-runtime-next')).status,202);
    assert.equal((await terminal(afterCleanup)).status,'succeeded');
    releaseCleanup();
    await Bun.sleep(10);
    assert.equal(daemon.journal.get(cleanupRoot)?.status,'cancelled');
    assert.equal(daemon.journal.get(afterCleanup)?.status,'succeeded');
  }finally{daemon.journal.close();}
  console.log("Real MCP timeout -> Pi error explanation, durable fallback, cancellation, late-result isolation and next message verified.");
} finally {
  executor.close();
  pluginJournal.close();
  await mcp.stop(true);
  rmSync(state, { recursive: true, force: true });
}
