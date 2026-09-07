import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaceApi, type PluginAccount } from "@/api";
import { ApplicationAccess } from "./ApplicationAccess";

const linearWork:PluginAccount={id:"linear-work",serverId:"linear-server",label:"Work workspace",provider:"linear",healthStatus:"ok",healthCode:null,checkedAt:null};
const linearPersonal:PluginAccount={...linearWork,id:"linear-personal",label:"Personal workspace"};
const github:PluginAccount={...linearWork,id:"github-work",serverId:"github-server",label:"the-vibe-company",provider:"github"};
const plugins={accounts:[linearWork,linearPersonal,github],catalog:[
  {id:"linear-server",name:"Linear",provider:"linear",available:true},
  {id:"github-server",name:"GitHub",provider:"github",available:true},
]};

afterEach(()=>vi.restoreAllMocks());

describe("ApplicationAccess",()=>{
  it("does not let a late StrictMode load undo a completed grant",async()=>{
    let resolveOld!:(value:{accounts:PluginAccount[]})=>void;
    vi.spyOn(workspaceApi,"plugins").mockResolvedValue(plugins);
    vi.spyOn(workspaceApi,"companionPlugins")
      .mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;}))
      .mockResolvedValueOnce({accounts:[]})
      .mockResolvedValue({accounts:[linearWork]});
    const grant=vi.spyOn(workspaceApi,"selectPlugin").mockResolvedValue({ok:true});
    render(<StrictMode><ApplicationAccess companionId="ada"/></StrictMode>);
    const checkbox=await screen.findByRole("checkbox",{name:"Work workspace"});
    fireEvent.click(checkbox);
    await waitFor(()=>expect(checkbox).toBeChecked());
    await act(async()=>{resolveOld({accounts:[]});});
    expect(checkbox).toBeChecked();
    expect(grant).toHaveBeenCalledExactlyOnceWith("ada","linear-work");
  });

  it("ignores a load from the previous companion after switching identity",async()=>{
    let resolveOld!:(value:{accounts:PluginAccount[]})=>void;
    vi.spyOn(workspaceApi,"plugins").mockResolvedValue(plugins);
    vi.spyOn(workspaceApi,"companionPlugins")
      .mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;}))
      .mockResolvedValue({accounts:[linearWork]});
    const view=render(<ApplicationAccess companionId="ada"/>);
    view.rerender(<ApplicationAccess companionId="grace"/>);
    const checkbox=await screen.findByRole("checkbox",{name:"Work workspace"});
    expect(checkbox).toBeChecked();
    await act(async()=>{resolveOld({accounts:[]});});
    expect(checkbox).toBeChecked();
  });

  it("groups several accounts per provider and grants each account separately",async()=>{
    let selected=[linearWork];
    vi.spyOn(workspaceApi,"plugins").mockResolvedValue(plugins);
    vi.spyOn(workspaceApi,"companionPlugins").mockImplementation(async()=>({accounts:selected}));
    const grant=vi.spyOn(workspaceApi,"selectPlugin").mockImplementation(async(_id,accountId)=>{selected=[...selected,plugins.accounts.find(account=>account.id===accountId)!];return {ok:true};});
    vi.spyOn(workspaceApi,"unselectPlugin");
    const user=userEvent.setup();render(<ApplicationAccess companionId="ada"/>);

    expect(await screen.findByRole("heading",{name:"Linear"})).toBeInTheDocument();
    expect(screen.getByRole("heading",{name:"GitHub"})).toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("checkbox",{name:"Work workspace"})).toBeChecked();
    expect(screen.getByRole("checkbox",{name:"Personal workspace"})).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox",{name:"Personal workspace"}));
    fireEvent.click(screen.getByRole("checkbox",{name:"Personal workspace"}));
    await waitFor(()=>expect(grant).toHaveBeenCalledTimes(1));
    await waitFor(()=>expect(screen.getByRole("checkbox",{name:"Personal workspace"})).toBeChecked());
    expect(screen.getByRole("checkbox",{name:"the-vibe-company"})).not.toBeChecked();
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
  });

  it("disables every account while pending, reloads truth after failure, and retries",async()=>{
    let selected:PluginAccount[]=[];let rejectFirst!:(cause:Error)=>void;let attempts=0;
    vi.spyOn(workspaceApi,"plugins").mockResolvedValue(plugins);
    vi.spyOn(workspaceApi,"companionPlugins").mockImplementation(async()=>({accounts:selected}));
    vi.spyOn(workspaceApi,"selectPlugin").mockImplementation(async(_id,accountId)=>{attempts+=1;if(attempts===1)return new Promise((_resolve,reject)=>{rejectFirst=reject;});selected=[plugins.accounts.find(account=>account.id===accountId)!];return {ok:true};});
    vi.spyOn(workspaceApi,"unselectPlugin");
    const user=userEvent.setup();render(<ApplicationAccess companionId="ada"/>);
    const target=await screen.findByRole("checkbox",{name:"Work workspace"});
    fireEvent.click(target);
    await waitFor(()=>expect(screen.getAllByRole("checkbox").every(input=>(input as HTMLInputElement).disabled)).toBe(true));
    rejectFirst(new Error("Grant could not be saved."));
    expect(await screen.findByRole("alert")).toHaveTextContent("Grant could not be saved.");
    expect(target).not.toBeChecked();
    await user.click(target);
    await waitFor(()=>expect(target).toBeChecked());
    expect(attempts).toBe(2);
  });

  it("offers retry after load failure and the real connection action when empty",async()=>{
    vi.spyOn(workspaceApi,"plugins").mockRejectedValueOnce(new Error("Applications unavailable.")).mockResolvedValue({accounts:[],catalog:[]});
    vi.spyOn(workspaceApi,"companionPlugins").mockResolvedValue({accounts:[]});
    const onConnect=vi.fn();const user=userEvent.setup();render(<ApplicationAccess companionId="ada" onConnect={onConnect}/>);
    expect(await screen.findByRole("alert")).toHaveTextContent("Applications unavailable.");
    await user.click(screen.getByRole("button",{name:"Try again"}));
    await user.click(await screen.findByRole("button",{name:"Connect an account"}));
    expect(onConnect).toHaveBeenCalledOnce();
  });
});
