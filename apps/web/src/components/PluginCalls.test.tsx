import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { PluginCall } from "@/api";
import { PluginCalls, pluginCallLabel } from "./PluginCalls";

const call = (status: PluginCall["status"], outcome: PluginCall["outcome"], code?: PluginCall["code"]): PluginCall => ({
  requestId:"request-1",runId:"run-1",toolCallId:`tool-${status}-${outcome}-${code ?? "none"}`,connectionId:"connection-1",tool:"github.create_issue",attempt:1,phase:"call",status,outcome,code,startedAt:100,deadlineAt:200,updatedAt:150,
});

it("labels persisted application outcomes without implying an unconfirmed call succeeded", () => {
  expect(pluginCallLabel(call("running", "unknown"))).toBe("In progress");
  expect(pluginCallLabel(call("failed", "not_sent", "PLUGIN_TIMEOUT"))).toBe("Timed out");
  expect(pluginCallLabel(call("interrupted", "unknown", "PLUGIN_RESTARTED"))).toBe("Requires verification");
  expect(pluginCallLabel(call("succeeded", "confirmed"))).toBe("Completed");
  render(<PluginCalls calls={[call("running", "unknown"),call("failed", "not_sent", "PLUGIN_TIMEOUT"),call("interrupted", "unknown", "PLUGIN_RESTARTED"),call("succeeded", "confirmed")]}/>);
  expect(screen.getByRole("region",{name:"Application activity"})).toBeVisible();
  for (const label of ["In progress","Timed out","Requires verification","Completed"]) expect(screen.getByText(label)).toBeVisible();
});
