const draftKey = (companionId: string) => `companions.build:draft:${companionId}`;

export function readDraft(companionId: string): string {
  try {
    return sessionStorage.getItem(draftKey(companionId)) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(companionId: string, draft: string): void {
  try {
    if (draft) {
      sessionStorage.setItem(draftKey(companionId), draft);
    } else {
      sessionStorage.removeItem(draftKey(companionId));
    }
  } catch {
    // Storage unavailable — silently skip
  }
}

export function clearDraft(companionId: string): void {
  try {
    sessionStorage.removeItem(draftKey(companionId));
  } catch {
    // Storage unavailable — silently skip
  }
}
