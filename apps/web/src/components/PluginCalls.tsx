import { CircleAlert, CircleCheck, Clock3, LoaderCircle } from "lucide-react";
import type { PluginCall } from "@/api";
import "./PluginCalls.css";

const errorMessages:Record<string,string> = {
  PLUGIN_TIMEOUT:"The connected application did not respond before the deadline.",
  PLUGIN_RESPONSE_TIMEOUT:"The Companion could not finish its response after an application error. You can send another message.",
  PLUGIN_CANCELLED:"The connected call was cancelled.",
  PLUGIN_CONNECTION_FAILED:"The connected application could not be reached.",
  PLUGIN_REMOTE_FAILED:"The connected application returned an error or its result could not be confirmed.",
  PLUGIN_AUTH_FAILED:"The application connection needs authentication.",
  PLUGIN_NOT_FOUND:"The requested application resource was not found.",
  PLUGIN_RATE_LIMITED:"The connected application is temporarily limiting requests.",
  PLUGIN_RESTARTED:"The agent restarted during an application call. Its result needs verification.",
  PLUGIN_POLL_LIMIT:"The status check reached its limit. The external task may still be running.",
  PLUGIN_RECONCILIATION_REQUIRED:"An earlier application result needs verification before another change can be made.",
};
export function pluginErrorMessage(error:string){return errorMessages[error]??error;}
const timeoutCodes = new Set(["PLUGIN_TIMEOUT", "PLUGIN_RESPONSE_TIMEOUT", "PLUGIN_POLL_LIMIT"]);

export function pluginCallLabel(call: PluginCall) {
  if (call.status === "running") return "In progress";
  if (call.outcome === "unknown") return "Requires verification";
  if (call.code && timeoutCodes.has(call.code)) return "Timed out";
  if (call.status === "succeeded") return "Completed";
  if (call.status === "interrupted") return "Interrupted";
  return "Failed";
}

function icon(call: PluginCall) {
  const label = pluginCallLabel(call);
  if (label === "In progress") return <LoaderCircle className="spin" aria-hidden="true"/>;
  if (label === "Completed") return <CircleCheck aria-hidden="true"/>;
  if (label === "Timed out") return <Clock3 aria-hidden="true"/>;
  return <CircleAlert aria-hidden="true"/>;
}

export function PluginCalls({ calls, runError, heading = "Application activity" }: { calls?: PluginCall[] | null; runError?: string|null; heading?: string }) {
  const error=runError?errorMessages[runError]:undefined;
  if (!calls?.length && !error) return null;
  return <section className="plugin-calls" aria-label={heading}>
    <h3>{heading}</h3>
    {error && <p className="plugin-call-error" role="alert">{error}</p>}
    <div className="plugin-call-list">{calls?.map(call => {
      const label = pluginCallLabel(call);
      return <div className={`plugin-call plugin-call--${label.toLowerCase().replaceAll(" ", "-")}`} key={`${call.toolCallId}:${call.attempt}`}>
        {icon(call)}<span><strong>{call.tool}</strong><small>{label}</small></span>
      </div>;
    })}</div>
  </section>;
}
