import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type CompanionDetail } from "@/api";
import { designSkill } from "../../../../../packages/workbench/profiles";
import type { ArtifactRevision, WorkbenchEvent } from "../../../../../packages/workbench/artifacts";
import { ArtifactPreview } from "./ArtifactPreview";
import { CompanionWorkbench } from "./CompanionWorkbench";
import { safePreviewDocument } from "./preview";

const companionId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const detail: CompanionDetail = { companion: { id: companionId, name: "Ada", instructions: "An editorial site for cooks", provider: "local", status: "ready", error: null, createdAt: "2026-09-10T00:00:00.000Z" }, messages: [], runs: [], activity: [] };
const design: CompanionDetail = { ...detail, companion: { ...detail.companion, profileId: "design-v1" } };
const revision: ArtifactRevision = { schemaVersion: 1, artifactId: "00000000-0000-4000-8000-000000000003", revisionId: "00000000-0000-4000-8000-000000000004", revision: 1, previousRevisionId: null, title: "Editorial", kind: "static-html", renderer: "sandboxed-html-v1", status: "ready", failureCode: null, source: { workspacePath: "artifacts/editorial/1.html", sha256: "a".repeat(64) }, provenance: { companionId, runId, conversation: { kind: "main", id: companionId }, profileId: "design-v1", skill: designSkill }, createdAt: "2026-09-10T00:00:00.000Z" };
afterEach(() => vi.restoreAllMocks());

describe("Companion workbench", () => {
  it.each([undefined, null, "default-v1"] as const)("preserves default chat and avoids artifact requests for %s", profileId => {
    const read = vi.spyOn(api, "workbench");
    const { container } = render(<CompanionWorkbench detail={{ ...detail, companion: { ...detail.companion, profileId } }} refreshVersion={0}><div>Existing chat</div></CompanionWorkbench>);
    expect(container.innerHTML).toBe("<div>Existing chat</div>");
    expect(read).not.toHaveBeenCalled();
  });
  it("resizes the conversation with the keyboard while the preview and inspector stay present", async () => {
    vi.spyOn(api,"workbench").mockResolvedValue({revisions:[],events:[],hasMore:false});
    const user=userEvent.setup();render(<CompanionWorkbench detail={design} refreshVersion={0}><textarea aria-label="Draft" defaultValue="Keep my thought"/></CompanionWorkbench>);
    const separator=screen.getByRole("separator",{name:"Resize conversation"});
    separator.focus();await user.keyboard("{ArrowRight}");expect(separator).toHaveAttribute("aria-valuenow","384");
    await user.keyboard("{Home}");expect(separator).toHaveAttribute("aria-valuenow","280");
    expect(screen.getByRole("region",{name:"Design stage"})).toBeVisible();
    expect(screen.getByRole("textbox",{name:"Draft"})).toHaveValue("Keep my thought");
  });
  it("composes native modules with saved brief and real conversation files, and lets the user hide them", async () => {
    vi.spyOn(api, "workbench").mockResolvedValue({ revisions: [], events: [], hasMore: false });
    const user = userEvent.setup();
    const withFiles = { ...design, files: [{ id: "f", runId, name: "Reference.png", mimeType: "image/png", size: 12, kind: "user_upload" as const, url: "/api/files/f" }] };
    render(<CompanionWorkbench detail={withFiles} refreshVersion={0}><div>Chat stays here</div></CompanionWorkbench>);
    await screen.findByText("A place to see your design");
    await user.click(screen.getByRole("button", { name: "Design brief" }));
    expect(screen.getByText(design.companion.instructions)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Assets" }));
    expect(screen.getByRole("link", { name: "Reference.png" })).toHaveAttribute("href", "/api/files/f");
    await user.click(screen.getByRole("button", { name: "Hide inspector" }));
    expect(screen.queryByRole("navigation", { name: "Workbench modules" })).toBeNull();
    expect(screen.getByText("Chat stays here")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Show inspector" }));
    expect(screen.getByRole("link", { name: "Reference.png" })).toBeVisible();
  });
  it("does not replay historical focus requests and accepts only new scoped typed requests", async () => {
    const event: WorkbenchEvent = { id: crypto.randomUUID(), type: "workbench.open", moduleId: "assets", provenance: revision.provenance, createdAt: revision.createdAt };
    const read = vi.spyOn(api, "workbench").mockResolvedValue({ revisions: [], events: [event], hasMore: false });
    const { rerender } = render(<CompanionWorkbench detail={design} refreshVersion={0}>Chat</CompanionWorkbench>);
    await screen.findByText("A place to see your design");
    expect(screen.getByRole("button", { name: "Design brief" })).toHaveAttribute("aria-pressed", "true");
    read.mockResolvedValue({ revisions: [], events: [{ ...event, id: crypto.randomUUID() }], hasMore: false });
    rerender(<CompanionWorkbench detail={design} refreshVersion={1}>Chat</CompanionWorkbench>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Assets" })).toHaveAttribute("aria-pressed", "true"));
    read.mockResolvedValue({ revisions: [], events: [{ ...event, id: crypto.randomUUID(), moduleId: "assets", provenance: { ...revision.provenance, companionId: runId } }], hasMore: false });
    rerender(<CompanionWorkbench detail={design} refreshVersion={2}>Chat</CompanionWorkbench>);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("button", { name: "Assets" })).toHaveAttribute("aria-pressed", "true");
  });
  it("retains persisted history when refresh fails and selects an exact historical revision", async () => {
    const read = vi.spyOn(api, "workbench").mockResolvedValue({ revisions: [revision], events: [], hasMore: false });
    const preview = vi.spyOn(api, "artifactPreview").mockResolvedValue({ revisionId: revision.revisionId, html: "<h1>Editorial</h1>" });
    const user = userEvent.setup();
    const { rerender } = render(<CompanionWorkbench detail={design} refreshVersion={0}>Chat</CompanionWorkbench>);
    fireEvent.load(await screen.findByTitle("Preparing design preview"));
    await user.click(screen.getByRole("button", { name: "History" }));
    read.mockRejectedValue(new Error("offline"));
    rerender(<CompanionWorkbench detail={design} refreshVersion={1}>Chat</CompanionWorkbench>);
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: /Editorial/ }));
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith(companionId, revision.artifactId, revision.revisionId));
  });
  it("keeps a selected older revision while refreshing the latest history page", async () => {
    const newer = {...revision, revisionId:crypto.randomUUID(), revision:2, title:"Latest design"};
    const read=vi.spyOn(api,"workbench").mockResolvedValueOnce({revisions:[newer],events:[],hasMore:true,nextCursor:"older"}).mockResolvedValueOnce({revisions:[revision],events:[],hasMore:false});
    const preview=vi.spyOn(api,"artifactPreview").mockImplementation(async(_id,_artifact,id)=>({revisionId:id,html:"<h1>Design</h1>"}));
    const user=userEvent.setup();
    const view=render(<CompanionWorkbench detail={design} refreshVersion={0}>Chat</CompanionWorkbench>);
    await screen.findByRole("heading",{name:"Latest design"});
    await user.click(screen.getByRole("button",{name:"History"}));
    await user.click(screen.getByRole("button",{name:"Load older revisions"}));
    await user.click(await screen.findByRole("button",{name:/Editorial/}));
    await waitFor(()=>expect(preview).toHaveBeenLastCalledWith(companionId,revision.artifactId,revision.revisionId));
    read.mockResolvedValue({revisions:[newer],events:[],hasMore:true,nextCursor:"older"});
    view.rerender(<CompanionWorkbench detail={design} refreshVersion={1}>Chat</CompanionWorkbench>);
    await waitFor(()=>expect(read).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("heading",{name:"Editorial"})).toBeVisible();
    expect(preview).toHaveBeenLastCalledWith(companionId,revision.artifactId,revision.revisionId);
  });
  it("does not let a late history page replace a refreshed publication", async () => {
    let finish!:(value:any)=>void;
    const read=vi.spyOn(api,"workbench").mockResolvedValueOnce({revisions:[revision],events:[],hasMore:true,nextCursor:"older"}).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    vi.spyOn(api,"artifactPreview").mockResolvedValue({revisionId:revision.revisionId,html:"<p>Design</p>"});
    const user=userEvent.setup();const view=render(<CompanionWorkbench detail={design} refreshVersion={0}>Chat</CompanionWorkbench>);
    await screen.findByRole("heading",{name:"Editorial"});await user.click(screen.getByRole("button",{name:"History"}));
    await user.click(screen.getByRole("button",{name:"Load older revisions"}));
    const latest={...revision,revisionId:crypto.randomUUID(),revision:2,title:"New publication"};
    read.mockResolvedValue({revisions:[latest],events:[],hasMore:true,nextCursor:"fresh"});
    view.rerender(<CompanionWorkbench detail={design} refreshVersion={1}>Chat</CompanionWorkbench>);
    await screen.findByRole("button",{name:/New publication/});
    finish({revisions:[],events:[],hasMore:false});
    await waitFor(()=>expect(screen.getByRole("button",{name:"Load older revisions"})).not.toBeDisabled());
    expect(screen.getByRole("button",{name:/New publication/})).toBeVisible();
  });

});

describe("static preview boundary", () => {
  it("identifies a newer retained preview when the selected historical revision has no valid snapshot", async () => {
    const second = { ...revision, revisionId: crypto.randomUUID(), revision: 2, previousRevisionId: revision.revisionId };
    vi.spyOn(api, "artifactPreview").mockResolvedValueOnce({ revisionId: second.revisionId, html: "<h1>Revision two</h1>" }).mockRejectedValueOnce(new Error("No preview before revision one"));
    const { rerender } = render(<ArtifactPreview companionId={companionId} revision={second}/>);
    fireEvent.load(await screen.findByTitle("Preparing design preview"));
    rerender(<ArtifactPreview companionId={companionId} revision={{ ...revision, status: "failed", failureCode: "generation_failed" }}/>);
    await screen.findByRole("alert");
    expect(screen.getByText("Published revision 2 · Static preview")).toBeVisible();
    expect(screen.queryByText(/from earlier history/)).toBeNull();
    expect(screen.getByTitle("Design artifact preview")).toHaveAttribute("srcdoc", expect.stringContaining("Revision two"));
  });
  it("removes executable, navigation and remote-loading markup before creating the sandbox document", () => {
    const source = '<h1 onclick="evil()">Title</h1><script>parent.evil()</script><iframe srcdoc="evil"></iframe><meta http-equiv="refresh" content="0;url=https://evil.test"><a href="javascript:evil()" ping="https://evil.test">Link</a><img src="https://evil.test/image"><svg onload="evil()"><a href="evil"/></svg><form action="https://evil.test"><input></form><style>h1{color:red}</style>';
    const safe = safePreviewDocument(source);
    expect(safe).toContain('<h1>Title</h1>');
    expect(safe).toContain("script-src 'none'");
    expect(safe).toContain("<style>h1{color:red}</style>");
    expect(safe).not.toMatch(/evil|<script|<iframe|<svg|<form|http-equiv="refresh"/);
  });
  it("keeps the last loaded preview on generation, validation, fetch and iframe failures", async () => {
    const blockAutomaticLoad = (event: Event) => { if (event.target instanceof HTMLIFrameElement && event.isTrusted) event.stopImmediatePropagation(); };
    document.addEventListener("load", blockAutomaticLoad, true);
    try {
    const read = vi.spyOn(api, "artifactPreview").mockResolvedValue({ revisionId: revision.revisionId, html: "<h1>Last valid</h1>" });
    const { rerender } = render(<ArtifactPreview companionId={companionId} revision={revision}/>);
    const first = await screen.findByTitle("Preparing design preview");
    expect(first).toHaveAttribute("sandbox", "");
    expect(first).toHaveAttribute("referrerpolicy", "no-referrer");
    fireEvent.load(first);
    expect(screen.getByTitle("Design artifact preview")).toHaveAttribute("srcdoc", expect.stringContaining("Last valid"));
    const failed = { ...revision, revisionId: crypto.randomUUID(), revision: 2, previousRevisionId: revision.revisionId, status: "failed" as const, failureCode: "generation_failed" as const };
    rerender(<ArtifactPreview companionId={companionId} revision={failed}/>);
    await screen.findByText(/Revision 2 failed/);
    read.mockRejectedValueOnce(new Error("offline"));
    rerender(<ArtifactPreview companionId={companionId} revision={{ ...failed, revisionId: crypto.randomUUID() }}/>);
    await screen.findByRole("alert");
    expect(screen.getByTitle("Design artifact preview")).toHaveAttribute("srcdoc", expect.stringContaining("Last valid"));
    read.mockResolvedValueOnce({ revisionId: crypto.randomUUID(), html: "a".repeat(256_001) });
    rerender(<ArtifactPreview companionId={companionId} revision={{ ...failed, revisionId: crypto.randomUUID() }}/>);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(4));
    expect(screen.getByTitle("Design artifact preview")).toHaveAttribute("srcdoc", expect.stringContaining("Last valid"));
    read.mockResolvedValueOnce({ revisionId: crypto.randomUUID(), html: "<h1>Candidate</h1>" });
    rerender(<ArtifactPreview companionId={companionId} revision={{ ...revision, revisionId: crypto.randomUUID() }}/>);
    fireEvent.error(await screen.findByTitle("Preparing design preview"));
    expect(screen.getByTitle("Design artifact preview")).toHaveAttribute("srcdoc", expect.stringContaining("Last valid"));
    } finally { document.removeEventListener("load", blockAutomaticLoad, true); }
  });
});
