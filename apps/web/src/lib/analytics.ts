import posthog from "posthog-js";

// Scrub nested person-property envelopes as well as event properties. The SDK
// also stores entry URLs and initial attribution outside $current_url.
function stripUrlCredentials(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && (key.endsWith("_url") || key.endsWith("_referrer"))) {
      try {
        const url = new URL(item);
        (value as Record<string, unknown>)[key] = url.origin + url.pathname;
      } catch { /* Non-URL attribution markers such as $direct are safe. */ }
    } else if (item && typeof item === "object") stripUrlCredentials(item);
  }
}

let initialized = false;
let identifiedUser: string | null = null;

export function initAnalytics() {
  const key = import.meta.env.VITE_POSTHOG_KEY;
  if (initialized || !import.meta.env.PROD || !key) return;
  posthog.init(key, {
    api_host: import.meta.env.VITE_POSTHOG_HOST || "https://us.i.posthog.com",
    capture_pageview: "history_change",
    // A browser may retain analytics identity after its auth session expires.
    // Start anonymous before the first pageview; App identifies verified users.
    loaded: instance => { if (instance.get_property("$user_state") === "identified") instance.reset(); },
    autocapture: false,
    capture_exceptions: false,
    capture_performance: false,
    disable_surveys: true,
    advanced_disable_feature_flags: true,
    capture_pageleave: false,
    disable_session_recording: true,
    save_campaign_params: false,
    save_referrer: false,
    person_profiles: "identified_only",
    // Magic links and billing redirects may carry credentials in query strings.
    // Keep only origin/path in event and person-property payloads.
    property_denylist: ["$initial_current_url", "$initial_referrer", "$referrer", "$initial_referring_domain"],
    before_send: event => {
      stripUrlCredentials(event);
      if (event) {
        event.properties.$current_url = window.location.origin + window.location.pathname;
        delete event.properties.$referrer;
        delete event.properties.$initial_referrer;
        delete event.properties.$initial_current_url;
      }
      return event;
    },
  });
  initialized = true;
}

export function identifyAnalytics(userId: string | null) {
  if (!initialized || identifiedUser === userId) return;
  if (userId) posthog.identify(userId);
  else posthog.reset();
  identifiedUser = userId;
}
