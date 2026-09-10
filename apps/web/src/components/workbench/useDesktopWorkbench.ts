import { useSyncExternalStore } from "react";

const query = "(min-width: 1001px)";
function subscribe(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(query);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
function snapshot() {
  return typeof window.matchMedia !== "function" || window.matchMedia(query).matches;
}

/** Mobile keeps the same mounted chat, without fetching or rendering studio previews. */
export function useDesktopWorkbench() {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
