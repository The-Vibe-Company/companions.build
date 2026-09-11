import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { CreateCompanion } from "./CreateCompanion";

function response(body: unknown,status=200) { return Promise.resolve(new Response(JSON.stringify(body), { status,headers: { "content-type": "application/json" } })); }

it("creates a permanent companion without template or specialist setup", async () => {
  const created = { id: "ada", name: "Ada", instructions: "Research", provider: "box", status: "preparing", error: null, createdAt: new Date().toISOString(), avatar: { shape: 1, color: 2, face: 0 } };
  const calls: Array<[string, RequestInit | undefined]> = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, options?: RequestInit) => { const path = String(input); calls.push([path, options]); if (path === "/api/plugins") return response({ catalog: [], accounts: [] }); if (path === "/api/companions") return response({ companion: created }); if(path==="/api/companions/ada/plugins")return response({accounts:[]}); throw Error(`Unexpected ${path}`); }));
  const onCreated = vi.fn(); const actor = userEvent.setup(); render(<CreateCompanion config={{ localAvailable: false, boxAvailable: true, model: "test" }} onCreated={onCreated}/>);
  await actor.type(await screen.findByLabelText("Name"), "Ada"); await actor.type(screen.getByLabelText("Role"), "Research"); await actor.click(screen.getByRole("button", { name: "Create companion" }));
  expect(onCreated).toHaveBeenCalledWith(created);
  const body = JSON.parse(String(calls.find(([path]) => path === "/api/companions")?.[1]?.body));
  expect(body).not.toHaveProperty("templateId");
  expect(screen.queryByText(/specialist/i)).not.toBeInTheDocument();
  vi.unstubAllGlobals();
});

it("reconciles persisted grants before completing a retried creation",async()=>{
 const account=(id:string,label:string)=>({id,serverId:"linear",label,provider:"linear",healthStatus:"ok",healthCode:null,checkedAt:null});
 const work=account("work","Work"),personal=account("personal","Personal");
 const created={id:"ada",name:"Ada",instructions:"Research",provider:"box",status:"preparing",error:null,createdAt:new Date().toISOString(),avatar:{shape:1,color:2,face:0}};
 let grants:string[]=[],personalAttempts=0;const calls:Array<[string,string]> = [];
 vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL,options?:RequestInit)=>{
  const path=String(input),method=options?.method??"GET";calls.push([method,path]);
  if(path==="/api/plugins")return response({catalog:[{id:"linear",name:"Linear",provider:"linear",available:true}],accounts:[work,personal]});
  if(path==="/api/companions"&&method==="POST")return response({companion:created});
  if(path==="/api/companions/ada/plugins"&&method==="GET")return response({accounts:[work,personal].filter(item=>grants.includes(item.id))});
  if(path==="/api/companions/ada/plugins/work"&&method==="PUT"){grants.push("work");return response({ok:true});}
  if(path==="/api/companions/ada/plugins/work"&&method==="DELETE"){grants=grants.filter(id=>id!=="work");return response({ok:true});}
  if(path==="/api/companions/ada/plugins/personal"&&method==="PUT"){personalAttempts++;if(personalAttempts===1)return response({error:"Unknown grant result"},503);grants.push("personal");return response({ok:true});}
  throw Error(`Unexpected ${method} ${path}`);
 }));
 const onCreated=vi.fn(),actor=userEvent.setup();render(<CreateCompanion ownerId="user-1" config={{localAvailable:false,boxAvailable:true,model:"test"}} onCreated={onCreated}/>);
 await actor.type(await screen.findByLabelText("Name"),"Ada");await actor.type(screen.getByLabelText("Role"),"Research");
  await actor.click(screen.getByRole("checkbox",{name:"Work"}));await actor.click(screen.getByRole("checkbox",{name:"Personal"}));
  await actor.click(screen.getByRole("button",{name:"Create companion"}));
  await waitFor(()=>expect(personalAttempts).toBe(1));
 expect(await screen.findByRole("alert")).toHaveTextContent("Unknown grant result");expect(grants).toEqual(["work"]);
 await actor.click(screen.getByRole("checkbox",{name:"Work"}));
 await actor.click(screen.getByRole("button",{name:"Create companion"}));
 await waitFor(()=>expect(onCreated).toHaveBeenCalledWith(created));
 expect(grants).toEqual(["personal"]);
 expect(calls.filter(([method,path])=>method==="POST"&&path==="/api/companions")).toHaveLength(1);
 expect(calls).toContainEqual(["DELETE","/api/companions/ada/plugins/work"]);
 vi.unstubAllGlobals();
});
