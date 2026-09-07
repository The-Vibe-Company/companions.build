import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LandingPage } from "./LandingPage";

afterEach(() => { document.title = "companions.build"; });

it("presents the supplied landing structure with truthful private-beta actions", async () => {
  const onLogin = vi.fn();
  render(<LandingPage onLogin={onLogin} />);

  expect(screen.getByRole("heading", { name: "Your AI companions. Give them something to do." })).toBeInTheDocument();
  expect(screen.getByText("Open source · Private beta")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Three steps to your first companion." })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Start with something on your list." })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "You stay in charge." })).toBeInTheDocument();
  const invitation = screen.getByText("Who can join the private beta?");
  await userEvent.click(invitation);
  expect(screen.getByText("Access is currently limited to invited, verified email addresses.")).toBeInTheDocument();
  expect(document.title).toBe("companions.build — Your AI companions");

  await userEvent.click(screen.getAllByRole("button", { name: /Log in to private beta/ })[0]);
  expect(onLogin).toHaveBeenCalledOnce();
  expect(screen.getAllByRole("link", { name: "Open source" })[0]).toHaveAttribute("href", "https://github.com/The-Vibe-Company/companions.build");
  expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
  expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
  expect(screen.getByText(/With Gmail, it can read messages and create drafts/)).toBeInTheDocument();
});
