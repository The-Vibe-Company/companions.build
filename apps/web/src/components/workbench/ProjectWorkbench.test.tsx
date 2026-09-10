import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api, type CompanionDetail } from "@/api";
import { ChatComposer } from "../ChatComposer";
import { CompanionWorkbench } from "./CompanionWorkbench";
import type { DesignProject } from "../../../../../packages/workbench/projects";

const companionId="00000000-0000-4000-8000-000000000001";
const detail:CompanionDetail={companion:{id:companionId,name:"Design partner",instructions:"Designer",provider:"local",status:"ready",error:null,profileId:"design-v2",createdAt:"2026-09-10T00:00:00.000Z"},messages:[],runs:[],activity:[]};
function project(number:number):DesignProject { return {id:`00000000-0000-4000-8000-${String(number).padStart(12,"0")}`,companionId,name:`Project ${number}`,brief:`Brief ${number}`,revision:1,archived:false,createdAt:"2026-09-10T00:00:00.000Z",updatedAt:"2026-09-10T00:00:00.000Z"}; }
beforeEach(()=>{sessionStorage.clear();localStorage.clear();vi.spyOn(api,"workbench").mockResolvedValue({revisions:[],events:[],hasMore:false});});
afterEach(()=>vi.restoreAllMocks());
function mount(chat=true) {return render(<CompanionWorkbench detail={detail} refreshVersion={0}>{chat?<ChatComposer detail={detail} onRefresh={async()=>{}} onUnauthorized={()=>{}}/>:<div>Shared chat</div>}</CompanionWorkbench>);}

describe("Design projects",()=>{
  it("keeps ten projects in one conversation and sends the explicitly selected project",async()=>{
    const projects=Array.from({length:10},(_,i)=>project(i+10));
    vi.spyOn(api,"designProjects").mockResolvedValue({projects,nextCursor:null});
    vi.spyOn(api,"designProject").mockImplementation(async(_id,id)=>({project:projects.find(item=>item.id===id)!}));
    const send=vi.spyOn(api,"sendMessage").mockResolvedValue({runId:"run"});
    const user=userEvent.setup();mount();
    await user.click(screen.getByRole("button",{name:/Switch project:/}));
    await user.click(await screen.findByRole("button",{name:"Open project Project 10"}));
    await screen.findByText("To: Project 10");
    const composer=screen.getByRole("textbox",{name:/message/i});
    await user.type(composer,"Create the first concept");
    fireEvent.submit(composer.closest("form")!);
    await waitFor(()=>expect(send).toHaveBeenLastCalledWith(companionId,"Create the first concept",[],projects[0].id));
    await user.click(screen.getByRole("button",{name:/Switch project:/}));
    await user.click(await screen.findByRole("button",{name:"Open project Project 19"}));
    await screen.findByText("To: Project 19");
    expect(screen.getByRole("textbox",{name:/message/i})).toBe(composer);
    await user.type(composer,"Create another concept");fireEvent.submit(composer.closest("form")!);
    await waitFor(()=>expect(send).toHaveBeenLastCalledWith(companionId,"Create another concept",[],projects[9].id));
  });
  it("retains a creation intent across a lost response and reload instead of duplicating a project",async()=>{
    vi.spyOn(api,"designProjects").mockResolvedValue({projects:[],nextCursor:null});
    const create=vi.spyOn(api,"createDesignProject").mockRejectedValueOnce(Error("lost")).mockImplementationOnce(async(_id,input)=>({project:{...project(20),id:input.id,name:input.name,brief:input.brief}}));
    vi.spyOn(api,"designProject").mockImplementation(async(_id,id)=>({project:{...project(20),id,name:"Magazine",brief:"Editorial"}}));
    const user=userEvent.setup();const view=mount(false);
    await user.click(screen.getByRole("button",{name:"New project"}));
    await user.type(screen.getByRole("textbox",{name:"Project name"}),"Magazine");
    await user.type(screen.getByRole("textbox",{name:"Brief"}),"Editorial");
    await user.click(screen.getByRole("button",{name:"Create project"}));
    await screen.findByText(/creation could not be confirmed/);
    const original=create.mock.calls[0][1];view.unmount();mount(false);
    expect(screen.getByRole("textbox",{name:"Project name"})).toBeDisabled();
    await user.click(screen.getByRole("button",{name:"Retry project creation"}));
    await waitFor(()=>expect(create).toHaveBeenCalledTimes(2));expect(create.mock.calls[1][1]).toEqual(original);
    await screen.findByRole("button",{name:"Switch project: Magazine"});
    expect(sessionStorage.getItem(`companions.design.creation:${companionId}`)).toBeNull();
  });
  it("keeps unsaved project brief edits on an optimistic conflict and reloads explicitly",async()=>{
    const saved=project(30);sessionStorage.setItem(`companions.design.project:${companionId}`,saved.id);
    vi.spyOn(api,"designProjects").mockResolvedValue({projects:[saved],nextCursor:null});
    const read=vi.spyOn(api,"designProject").mockResolvedValue({project:saved});
    const update=vi.spyOn(api,"updateDesignProject").mockRejectedValue(Error("conflict"));
    const user=userEvent.setup();mount(false);await screen.findByRole("button",{name:`Switch project: ${saved.name}`});
    await user.click(screen.getByRole("button",{name:"Design brief"}));
    const brief=await screen.findByRole("textbox",{name:"Design brief"});await user.clear(brief);await user.type(brief,"My unsaved direction");
    await user.click(screen.getByRole("button",{name:"Assets"}));
    await user.click(screen.getByRole("button",{name:"Design brief"}));
    expect(screen.getByRole("textbox",{name:"Design brief"})).toBe(brief);
    expect(brief).toHaveValue("My unsaved direction");
    await user.click(screen.getByRole("button",{name:"Hide inspector"}));
    await user.click(screen.getByRole("button",{name:"Show inspector"}));
    expect(screen.getByRole("textbox",{name:"Design brief"})).toBe(brief);
    expect(brief).toHaveValue("My unsaved direction");
    await user.click(screen.getByRole("button",{name:"Save brief"}));
    await screen.findByText(/Your draft is kept/);expect(brief).toHaveValue("My unsaved direction");
    expect(update.mock.calls[0][2]).toEqual({expectedRevision:1,name:saved.name,brief:"My unsaved direction"});
    read.mockResolvedValue({project:{...saved,brief:"Another saved direction",revision:2}});
    await user.click(screen.getByRole("button",{name:"Reload saved version"}));
    await waitFor(()=>expect(brief).toHaveValue("Another saved direction"));
  });
  it("loads another project page and removes the prior project's preview immediately on selection",async()=>{
    const first=project(40),next=project(41);
    const list=vi.spyOn(api,"designProjects").mockResolvedValueOnce({projects:[first],nextCursor:"page2"}).mockResolvedValue({projects:[next],nextCursor:null});
    vi.spyOn(api,"designProject").mockImplementation(async(_id,id)=>({project:id===first.id?first:next}));
    const user=userEvent.setup();mount(false);await user.click(screen.getByRole("button",{name:/Switch project:/}));await screen.findByRole("button",{name:`Open project ${first.name}`});
    await user.click(screen.getByRole("button",{name:"Load more projects"}));await screen.findByRole("button",{name:`Open project ${next.name}`});
    expect(list).toHaveBeenLastCalledWith(companionId,"","page2");
    await user.click(screen.getByRole("button",{name:`Open project ${first.name}`}));
    await waitFor(()=>expect(api.workbench).toHaveBeenCalledWith(companionId,first.id));
    await user.click(screen.getByRole("button",{name:"Design brief"}));await screen.findByDisplayValue(first.brief);
    await user.click(screen.getByRole("button",{name:/Switch project:/}));
    await user.click(screen.getByRole("button",{name:`Open project ${next.name}`}));
    expect(screen.queryByDisplayValue(first.brief)).toBeNull();await screen.findByDisplayValue(next.brief);
  });
  it("searches beyond the loaded project page and keeps chat drafts through inspector changes", async () => {
    const distant=project(50);
    const list=vi.spyOn(api,"designProjects").mockImplementation(async(_id,query)=>({projects:query==="Editorial"?[{...distant,name:"Editorial journal"}]:[],nextCursor:null}));
    vi.spyOn(api,"designProject").mockResolvedValue({project:{...distant,name:"Editorial journal"}});
    const user=userEvent.setup(); mount();
    const composer=screen.getByRole("textbox",{name:/message/i});
    await user.type(composer,"Keep this thought");
    const switcher=screen.getByRole("button",{name:/Switch project:/});
    await user.click(switcher);
    await user.type(screen.getByRole("textbox",{name:"Search projects"}),"Editorial");
    await user.click(await screen.findByRole("button",{name:"Open project Editorial journal"}));
    await screen.findByText("To: Editorial journal");
    expect(list).toHaveBeenLastCalledWith(companionId,"Editorial");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(()=>expect(switcher).toHaveFocus());
    await user.click(screen.getByRole("button",{name:"Hide inspector"}));
    await user.click(screen.getByRole("button",{name:"Show inspector"}));
    expect(screen.getByRole("textbox",{name:/message/i})).toBe(composer);
    expect(composer).toHaveValue("Keep this thought");
  });
  it("uses a nonmodal drawer, pins the selected project once, and restores focus on Escape",async()=>{
    const current=project(60),other=project(61);sessionStorage.setItem(`companions.design.project:${companionId}`,current.id);
    vi.spyOn(api,"designProjects").mockResolvedValue({projects:[other],nextCursor:null});
    vi.spyOn(api,"designProject").mockResolvedValue({project:current});
    const user=userEvent.setup();mount(false);
    const switcher=await screen.findByRole("button",{name:`Switch project: ${current.name}`});
    await user.click(switcher);
    const drawer=screen.getByRole("dialog",{name:"Projects"});expect(drawer).not.toHaveAttribute("aria-modal");
    await waitFor(()=>expect(screen.getByRole("textbox",{name:"Search projects"})).toHaveFocus());
    const projectButtons=screen.getAllByRole("button",{name:/Open project/});
    expect(projectButtons[0]).toHaveAccessibleName(`Open project ${current.name}`);
    expect(screen.getAllByRole("button",{name:`Open project ${current.name}`})).toHaveLength(1);
    await user.keyboard("{Escape}");expect(screen.queryByRole("dialog",{name:"Projects"})).toBeNull();await waitFor(()=>expect(switcher).toHaveFocus());
    const newProject=screen.getByRole("button",{name:"New project"});await user.click(newProject);
    await waitFor(()=>expect(screen.getByRole("dialog",{name:"Projects"}).querySelector("input")).toHaveFocus());
    await user.keyboard("{Escape}");expect(screen.queryByRole("dialog",{name:"Projects"})).toBeNull();await waitFor(()=>expect(newProject).toHaveFocus());
  });

});
