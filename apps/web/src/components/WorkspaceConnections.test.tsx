import {render,screen,waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {afterEach,expect,it,vi} from "vitest";
import {workspaceApi} from "@/api";
import {ConnectionsPage} from "./WorkspaceConnections";

afterEach(()=>vi.restoreAllMocks());

it("opens OAuth synchronously and reloads only for a trusted completion",async()=>{
 const server={id:"linear",name:"Linear",provider:"linear",available:true};
 const account={id:"work",serverId:"linear",label:"Work",provider:"linear",healthStatus:"ok" as const,healthCode:null,checkedAt:null};
 let connected=false,resolveConnect!:(value:{url:string})=>void;
 const plugins=vi.spyOn(workspaceApi,"plugins").mockImplementation(async()=>({catalog:[server],accounts:connected?[account]:[]}));
 vi.spyOn(workspaceApi,"connectPlugin").mockImplementation(()=>new Promise(resolve=>{resolveConnect=resolve;}));
 const popup={closed:false,location:{href:""},close:vi.fn()};const open=vi.spyOn(window,"open").mockReturnValue(popup as unknown as Window);
 const actor=userEvent.setup();render(<ConnectionsPage onBack={vi.fn()}/>);
 await actor.click(await screen.findByRole("button",{name:"Connect"}));
 await actor.type(screen.getByLabelText("Account name"),"Work");
 await actor.click(screen.getByRole("button",{name:"Connect account"}));
 expect(open).toHaveBeenCalledWith("about:blank","companions-plugin-oauth","popup,width=620,height=760");
 expect(popup.location.href).toBe("");
 resolveConnect({url:"https://oauth.example/linear"});await waitFor(()=>expect(popup.location.href).toBe("https://oauth.example/linear"));
 window.dispatchEvent(new MessageEvent("message",{origin:"https://attacker.invalid",source:popup as unknown as Window,data:{type:"companions:plugin-oauth",status:"connected"}}));
 expect(plugins).toHaveBeenCalledTimes(1);
 connected=true;window.dispatchEvent(new MessageEvent("message",{origin:window.location.origin,source:popup as unknown as Window,data:{type:"companions:plugin-oauth",status:"connected"}}));
 expect(await screen.findByText("Connection added.")).toBeInTheDocument();
 await waitFor(()=>expect(plugins).toHaveBeenCalledTimes(2));
 expect(await screen.findByText("Work")).toBeInTheDocument();
});
