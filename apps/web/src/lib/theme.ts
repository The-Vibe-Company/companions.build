/**
 * Theme preference. `system` follows the OS and is the default; the resolved
 * value is written to `data-theme` on <html> so styles/tokens.css can switch.
 */
export type ThemePreference = "light" | "dark" | "system";

const KEY = "companions.build:theme";

export function readTheme(): ThemePreference {
  try {
    const value = localStorage.getItem(KEY);
    if (value === "light" || value === "dark" || value === "system") return value;
  } catch { /* storage is optional */ }
  return "system";
}

export function resolveTheme(preference: ThemePreference): "light" | "dark" {
  if (preference !== "system") return preference;
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(preference: ThemePreference): void {
  const resolved = resolveTheme(preference);
  document.documentElement.dataset.theme = resolved;
  // Keep browser chrome in step with the resolved theme.
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved === "dark" ? "#151517" : "#ffffff");
}

export function setTheme(preference: ThemePreference): void {
  try { localStorage.setItem(KEY, preference); } catch { /* storage is optional */ }
  applyTheme(preference);
}

/** Apply the stored preference now and follow OS changes while on `system`. */
export function initTheme(): void {
  applyTheme(readTheme());
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    if (readTheme() === "system") applyTheme("system");
  });
}
