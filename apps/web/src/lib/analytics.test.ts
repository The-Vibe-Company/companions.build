import { beforeEach, expect, test, vi } from "vitest";

const sdk = vi.hoisted(() => ({ init: vi.fn(), identify: vi.fn(), reset: vi.fn() }));
vi.mock("posthog-js", () => ({ default: sdk }));
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

test("production initializes once with history pageviews and US ingestion", async () => {
  vi.stubEnv("PROD", true); vi.stubEnv("VITE_POSTHOG_KEY", "test-project");
  const analytics = await import("./analytics");
  analytics.initAnalytics(); analytics.initAnalytics();
  expect(sdk.init).toHaveBeenCalledTimes(1);
  const options = sdk.init.mock.calls[0][1];
  expect(options).toMatchObject({api_host:"https://us.i.posthog.com",capture_pageview:"history_change",autocapture:false,disable_session_recording:true});
  const restored = { get_property: vi.fn(() => "identified"), reset: vi.fn() };
  options.loaded(restored);
  expect(restored.reset).toHaveBeenCalledTimes(1);
  window.history.replaceState({}, "", "/account?token=sensitive#secret");
  const event=options.before_send({properties:{$current_url:window.location.href,$referrer:"https://example.test/?token=sensitive"}});
  expect(event.properties).toEqual({$current_url:window.location.origin+"/account"});
  analytics.identifyAnalytics("user-1"); analytics.identifyAnalytics("user-1"); analytics.identifyAnalytics(null);
  expect(sdk.identify).toHaveBeenCalledExactlyOnceWith("user-1");
  expect(sdk.reset).toHaveBeenCalledTimes(1);
});

test("missing configuration and development do not start ingestion", async () => {
  vi.stubEnv("PROD", true); vi.stubEnv("VITE_POSTHOG_KEY", "");
  const analytics = await import("./analytics"); analytics.initAnalytics();
  vi.stubEnv("PROD", false); vi.stubEnv("VITE_POSTHOG_KEY", "test-project"); analytics.initAnalytics();
  analytics.identifyAnalytics("user-1");
  expect(sdk.init).not.toHaveBeenCalled(); expect(sdk.identify).not.toHaveBeenCalled();
});
