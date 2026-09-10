import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesignStudio, stageDesignContext } from "../src/design-studio";
import { RunJournal } from "../src/journal";
import { AgentDaemon } from "../src/daemon";
import { activeDesignSkill } from "../../workbench/profiles";
import type { DesignRunContext } from "../../workbench/projects";

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function fixture(call?: (...args:any[])=>Promise<any>) {
  const state = mkdtempSync(join(tmpdir(),"design-studio-"));
  const runId = crypto.randomUUID(), projectId = crypto.randomUUID();
  const context: DesignRunContext = {version:1,profileId:"design-v2",companionId:crypto.randomUUID(),project:{id:projectId,name:"Editorial",brief:"A bold magazine",revision:1},skill:activeDesignSkill};
  const calls:any[]=[];
  const studio = new DesignStudio(state,async(...args) => { calls.push(args); return call ? call(...args) : {revisionId:(args[2] as any).publicationId,revision:1}; });
  cleanup.push(()=>studio.close());
  const cwd=join(state,"workspace"); stageDesignContext(cwd,runId,context);
  const path=`projects/${projectId}/index.html`;writeFileSync(join(cwd,path),"<h1>Editorial</h1>");
  const input={publicationId:crypto.randomUUID(),artifactId:crypto.randomUUID(),previousRevisionId:null,title:"Editorial",path};
  return {state,runId,context,cwd,studio,calls,input};
}
describe("Design workspace publication",()=>{
  test("embeds verified skills and freezes a separate run context for each project without touching Pi sessions",()=>{
    const f=fixture();
    expect(readFileSync(join(f.cwd,`.design/runs/${f.runId}/skill/references/craft.md`),"utf8")).toContain("typ");
    expect(JSON.parse(readFileSync(join(f.cwd,`.design/runs/${f.runId}/context.json`),"utf8"))).toEqual(f.context);
    expect(()=>stageDesignContext(f.cwd,f.runId,{...f.context,project:{...f.context.project,brief:"Changed"}})).toThrow("DESIGN_SNAPSHOT_CONFLICT");
    const next=crypto.randomUUID();stageDesignContext(f.cwd,next,{...f.context,project:{...f.context.project,id:crypto.randomUUID()}});
    expect(readFileSync(join(f.cwd,`.design/runs/${f.runId}/context.json`),"utf8")).toContain("A bold magazine");
  });
  test("snapshots exact bytes before the durable control call and returns the same completed result on retry",async()=>{
    const f=fixture(async(_run,_operation,payload)=>{
      expect(readFileSync(join(f.cwd,payload.workspacePath),"utf8")).toBe(payload.html);
      return {revisionId:payload.publicationId,revision:1};
    });
    const result=await f.studio.publish(f.runId,f.context,f.input);
    expect(result.revisionId).toBe(f.input.publicationId);
    writeFileSync(join(f.cwd,f.input.path),"<h1>Later edit</h1>");
    expect(await f.studio.publish(f.runId,f.context,f.input)).toEqual(result);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0][2].html).toBe("<h1>Editorial</h1>");
    expect(f.calls[0][2].projectId).toBe(f.context.project.id);
  });
  test("rejects conflicting request identity and cross-project files",async()=>{
    const f=fixture();await f.studio.publish(f.runId,f.context,f.input);
    expect(await f.studio.publish(f.runId,f.context,{...f.input,title:"Different"})).toEqual({error:"PUBLICATION_ID_CONFLICT"});
    mkdirSync(join(f.cwd,"projects","other"));writeFileSync(join(f.cwd,"projects/other/index.html"),"<h1>Private</h1>");
    const result=await f.studio.publish(f.runId,f.context,{...f.input,publicationId:crypto.randomUUID(),path:"projects/other/index.html"});
    expect(result.error).toBe("DESIGN_FILE_OUTSIDE_PROJECT");expect(f.calls).toHaveLength(1);
  });
  test("rejects symlinked sources outside the project and symlinked snapshot directories",async()=>{
    const f=fixture();const outside=join(f.state,"secret.html");writeFileSync(outside,"private");
    symlinkSync(outside,join(f.cwd,`projects/${f.context.project.id}/link.html`));
    expect((await f.studio.publish(f.runId,f.context,{...f.input,path:`projects/${f.context.project.id}/link.html`})).error).toBe("DESIGN_FILE_OUTSIDE_PROJECT");
    symlinkSync(f.state,join(f.cwd,"artifacts"));
    expect((await f.studio.publish(f.runId,f.context,{...f.input,publicationId:crypto.randomUUID()})).error).toBe("DESIGN_PATH_INVALID");
    expect(f.calls).toHaveLength(0);
  });
  test("retains snapshots and never replays an uncertain remote publication",async()=>{
    const f=fixture(async()=>{throw Error("network lost with secret payload");});
    const first=await f.studio.publish(f.runId,f.context,f.input);
    expect(first.error).toBe("PUBLICATION_OUTCOME_UNKNOWN");expect(JSON.stringify(first)).not.toContain("secret");
    expect(await f.studio.publish(f.runId,f.context,f.input)).toEqual(first);expect(f.calls).toHaveLength(1);
    const reopened=new DesignStudio(f.state,async()=>{throw Error("MUST_NOT_REPLAY");});cleanup.push(()=>reopened.close());
    expect(await reopened.publish(f.runId,f.context,f.input)).toEqual(first);
    expect(readFileSync(join(f.cwd,`artifacts/projects/${f.context.project.id}/${f.input.artifactId}/${f.input.publicationId}.html`),"utf8")).toContain("Editorial");
  });
  test("rejects cancellation before publication and duplicate concurrent effects",async()=>{
    const f=fixture();const abort=new AbortController();abort.abort();
    expect((await f.studio.publish(f.runId,f.context,f.input,abort.signal)).error).toBe("DESIGN_PUBLICATION_CANCELLED");
    expect(f.calls).toHaveLength(0);
    const input={...f.input,publicationId:crypto.randomUUID()};
    const [first,second]=await Promise.all([f.studio.publish(f.runId,f.context,input),f.studio.publish(f.runId,f.context,input)]);
    expect(first.revisionId).toBe(input.publicationId);expect(second.error).toBe("PUBLICATION_OUTCOME_UNKNOWN");expect(f.calls).toHaveLength(1);
  });
  test("binds daemon request identity to the project snapshot while preserving legacy requests",()=>{
    const f=fixture();const journal=new RunJournal(join(f.state,"runs.sqlite"));cleanup.push(()=>journal.close());
    const input={content:"Design this",instructions:"Role",designContext:f.context};
    expect(journal.accept(f.runId,input).kind).toBe("accepted");
    expect(journal.accept(f.runId,input).kind).toBe("existing");
    expect(journal.accept(f.runId,{...input,designContext:{...f.context,project:{...f.context.project,revision:2}}}).kind).toBe("conflict");
    const legacy=crypto.randomUUID();expect(journal.accept(legacy,{content:"Hello",instructions:"Role"}).kind).toBe("accepted");
    expect(journal.accept(legacy,{content:"Hello",instructions:"Role"}).kind).toBe("existing");
  });
  test("daemon refuses cross-project steering before accepting an execution ID",async()=>{
    const f=fixture();let finish!:()=>void,steered=0;
    const daemon=new AgentDaemon(f.state,"design-test-token",{
      execute:async()=>{await new Promise<void>(resolve=>{finish=resolve;});return {text:"Done"};},
      steer:async()=>{steered++;},cancel:async()=>{finish?.();},
    });cleanup.push(()=>daemon.close());
    const put=(id:string,designContext:DesignRunContext)=>daemon.fetch(new Request(`http://agent/runs/${id}`,{method:"PUT",headers:{authorization:"Bearer design-test-token"},body:JSON.stringify({content:"Design",instructions:"Role",designContext})}));
    expect((await put(f.runId,f.context)).status).toBe(202);
    const rejected=crypto.randomUUID();expect((await put(rejected,{...f.context,project:{...f.context.project,id:crypto.randomUUID()}})).status).toBe(409);
    expect(daemon.journal.get(rejected)).toBeNull();expect(steered).toBe(0);
    expect((await put(crypto.randomUUID(),f.context)).status).toBe(202);expect(steered).toBe(1);
    await daemon.fetch(new Request(`http://agent/runs/${f.runId}/cancel`,{method:"POST",headers:{authorization:"Bearer design-test-token"}}));
  });
});
