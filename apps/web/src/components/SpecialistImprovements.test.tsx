import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpecialistImprovements } from "./SpecialistImprovements";

const response = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
beforeEach(() => vi.unstubAllGlobals());

describe("SpecialistImprovements", () => {
  it("prepares a proposal without presenting it as already installed", async () => {
    let improvement = { id: "i1", templateId: "t1", summary: "Keep the repository formatter in the prepared image", recipe: "bun add -g prettier", status: "proposed", baseRevision: 2, sourceCompanionId: "child" };
    const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/companions/c1/specialist-improvements") return response({ improvements: [improvement] });
      if (path === "/api/specialist-improvements/i1/apply" && options?.method === "POST") { improvement = { ...improvement, status: "applied" }; return response({ status: "applied", companionId: "draft-1", runId: "run-1" }); }
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SpecialistImprovements companionId="c1" />);
    expect(await screen.findByText(improvement.summary)).toBeInTheDocument();
    expect(screen.queryByText(/installed/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Prepare improvement" }));
    await screen.findByRole("button", { name: "Open draft" });
    const body = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(body.commandId).toEqual(expect.any(String));
  });
});
