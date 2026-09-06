import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageResponse } from "./ai-elements/message";

describe("MessageResponse", () => {
  it("renders GFM structure and keeps links in a safe separate tab", () => {
    render(<MessageResponse>{"## Result\n\n| File | State |\n| --- | --- |\n| report.md | ready |\n\n[Open report](https://example.com/report)"}</MessageResponse>);
    expect(screen.getByRole("heading", { name: "Result" })).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open report" })).toHaveAttribute("rel", "noreferrer");
  });
});
