import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MailPanel } from "./MailPanel";

const quota = { used: 2, limit: 50, resetsAt: "2026-09-08T00:00:00Z" };
const mailbox = { address: "stan.ada@mail.companions.build", localName: "ada" };
const response = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
afterEach(() => vi.unstubAllGlobals());

it("persists a preview before requiring a separate send approval", async () => {
  let draft: Record<string, unknown> | null = null;
  let approved = false;
  const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/mail") && !options?.method) return response({ configured: true, mailbox, senders: [], messages: approved ? [{ ...draft, state: "queued" }] : draft ? [draft] : [], quota });
    if (path.endsWith("/mail/messages") && options?.method === "POST") {
      const body = JSON.parse(String(options.body));
      draft = { id: "draft-1", threadId: "thread-1", direction: "outbound", state: "draft", sender: mailbox.address, to: body.to, cc: body.cc, bcc: body.bcc, subject: body.subject, text: body.text, html: null, attachments: [], createdAt: "2026-09-07T10:00:00Z", sendAfter: null, errorCode: null };
      return response({ message: draft }, 201);
    }
    if (path.endsWith("/draft-1/approve") && options?.method === "POST") { approved = true; return response({ message: { ...draft, state: "queued" } }); }
    throw new Error(`Unexpected ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<MailPanel companionId="ada" companionName="Ada" />);
  await screen.findByText(/48 of 50 recipient units/);
  await user.click(screen.getByRole("button", { name: "New email" }));
  await user.type(screen.getByLabelText("To"), "alex@example.com, sam@example.com");
  await user.type(screen.getByLabelText("Subject"), "Weekly brief");
  await user.type(screen.getByLabelText("Message"), "Here is the brief.");
  await user.click(screen.getByRole("button", { name: "Prepare preview" }));
  expect(await screen.findByText("Draft prepared. Review it before sending.")).toBeInTheDocument();
  expect(approved).toBe(false);
  expect(JSON.parse(String(fetchMock.mock.calls.find(call => String(call[0]).endsWith("/mail/messages"))?.[1]?.body))).toMatchObject({ to: ["alex@example.com", "sam@example.com"] });
  await user.click(screen.getByRole("button", { name: "Send now" }));
  await waitFor(() => expect(approved).toBe(true));
});

it("keeps a quota-blocked draft actionable without retrying it automatically", async () => {
  const blocked = { id: "draft-cap", threadId: "thread-cap", direction: "outbound", state: "quota_exceeded", sender: mailbox.address, to: ["alex@example.com"], cc: [], bcc: [], subject: "At cap", text: "Review tomorrow", html: null, attachments: [], createdAt: "2026-09-07T10:00:00Z", sendAfter: null, errorCode: "quota_exceeded" };
  let reminderBody: Record<string, unknown> | null = null;
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/mail") && !options?.method) return response({ configured: true, mailbox, senders: [], messages: [blocked], quota: { ...quota, used: 50 } });
    if (path.endsWith("/routines") && options?.method === "POST") { reminderBody = JSON.parse(String(options.body)); return response({ routine: { id: "once-1", ...reminderBody } }, 201); }
    throw new Error(`Unexpected ${path}`);
  }));
  const user = userEvent.setup();
  render(<MailPanel companionId="ada" companionName="Ada" />);
  await user.click(await screen.findByRole("tab", { name: "Drafts" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("quota exceeded");
  expect(screen.queryByRole("button", { name: "Send now" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Send tomorrow" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Remind me tomorrow" }));
  await waitFor(() => expect(reminderBody).toMatchObject({ runAt: expect.any(String), enabled: true }));
  expect(reminderBody).not.toHaveProperty("timezone");
});
