import { render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { LegalPage } from "./LegalPage";

afterEach(() => { document.title = "companions.build"; });

it("discloses Gmail access, storage, transfers, and Limited Use commitments", () => {
  render(<LegalPage kind="privacy" />);
  expect(screen.getByRole("heading", { name: "Privacy Policy" })).toBeInTheDocument();
  expect(screen.getByText(/Read-only Gmail access/)).toBeInTheDocument();
  expect(screen.getByText(/Compose Gmail access/)).toBeInTheDocument();
  expect(screen.getByText(/currently exposes creating and listing drafts only/)).toBeInTheDocument();
  expect(screen.getByText(/does not expose sending, deleting, or changing messages or labels/)).toBeInTheDocument();
  expect(screen.getByText(/OAuth credentials are stored encrypted/)).toBeInTheDocument();
  expect(screen.getByText(/Limited Use requirements/)).toBeInTheDocument();
  expect(screen.getByText(/do not sell Google user data/)).toBeInTheDocument();
  expect(screen.getAllByRole("link", { name: "stan@thevibecompany.co" })).not.toHaveLength(0);
  expect(document.title).toBe("Privacy Policy — companions.build");
});

it("provides public terms with connected-app and AI responsibilities", () => {
  render(<LegalPage kind="terms" />);
  expect(screen.getByRole("heading", { name: "Terms of Use" })).toBeInTheDocument();
  expect(screen.getByText(/connect third-party accounts, including Gmail/)).toBeInTheDocument();
  expect(screen.getByText(/AI systems can make mistakes/)).toBeInTheDocument();
  expect(screen.getByText(/service operated by The Vibe Company/)).toBeInTheDocument();
  expect(document.title).toBe("Terms of Use — companions.build");
});
