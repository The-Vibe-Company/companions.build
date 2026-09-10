import { afterEach, describe, expect, it } from "vitest";
import { clearDraft, readDraft, saveDraft } from "./companion-drafts";

afterEach(() => sessionStorage.clear());

describe("companion drafts", () => {
  it("returns empty string for a companion with no saved draft", () => {
    expect(readDraft("ada")).toBe("");
  });

  it("saves and restores a draft for a companion", () => {
    saveDraft("ada", "Hello Ada");
    expect(readDraft("ada")).toBe("Hello Ada");
  });

  it("isolates drafts between companions", () => {
    saveDraft("ada", "Ada message");
    saveDraft("browser", "Browser message");
    expect(readDraft("ada")).toBe("Ada message");
    expect(readDraft("browser")).toBe("Browser message");
  });

  it("removes the storage key when draft is empty", () => {
    saveDraft("ada", "something");
    saveDraft("ada", "");
    expect(sessionStorage.getItem("companions.build:draft:ada")).toBeNull();
    expect(readDraft("ada")).toBe("");
  });

  it("clearDraft removes only the target companion draft", () => {
    saveDraft("ada", "Ada message");
    saveDraft("browser", "Browser message");
    clearDraft("ada");
    expect(readDraft("ada")).toBe("");
    expect(readDraft("browser")).toBe("Browser message");
  });

  it("overwrite replaces the previous draft", () => {
    saveDraft("ada", "first draft");
    saveDraft("ada", "updated draft");
    expect(readDraft("ada")).toBe("updated draft");
  });

  it("handles unavailable sessionStorage gracefully", () => {
    const orig = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    Object.defineProperty(window, "sessionStorage", {
      get() { throw new Error("Storage unavailable"); },
      configurable: true,
    });
    try {
      expect(() => saveDraft("ada", "text")).not.toThrow();
      expect(readDraft("ada")).toBe("");
      expect(() => clearDraft("ada")).not.toThrow();
    } finally {
      if (orig) Object.defineProperty(window, "sessionStorage", orig);
    }
  });
});
