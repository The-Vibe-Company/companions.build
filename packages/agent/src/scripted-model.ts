// Explicit test boundary. Pi's agent loop, SessionManager and built-in tools remain real.
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

export function scriptedModel(model: any, context: any) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "text", text: "Scripted response." }], stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const userIndex = context.messages.findLastIndex((item: any) => item.role === "user");
  const user = context.messages[userIndex];
  const text = typeof user?.content === "string" ? user.content : user?.content
    ?.filter((item: any) => item.type === "text").map((item: any) => item.text).join("");
  const results = context.messages.slice(userIndex + 1).filter((item: any) => item.role === "toolResult");
  const tool = (name: string, args: Record<string, unknown>) => {
    message.content = [{ type: "toolCall", id: `fixture-${results.length}`, name, arguments: args }];
    message.stopReason = "toolUse";
  };
  if (text === "write-note") {
    if (results.length === 0) tool("write", { path: "note.txt", content: "written by real Pi tools\n" });
    else if (results.length === 1) tool("read", { path: "note.txt" });
    else message.content = [{ type: "text", text: JSON.stringify(results.at(-1)?.content).includes("written by real Pi tools")
      ? "The note was written and read back." : "Tool verification failed." }];
  } else if (text === "slow-write") {
    if (results.length === 0) tool("bash", { command: "printf started > slow-started; sleep 30; printf completed > should-not-exist" });
    else message.content = [{ type: "text", text: "Slow command returned." }];
  } else if (text === "crash-after-effect") {
    if (results.length === 0) tool("bash", { command: "printf effect >> effects.txt; sleep 30" });
    else message.content = [{ type: "text", text: "Effect completed." }];
  } else if (text === "background-hold" || text === "main-hold") {
    const marker = text === "background-hold" ? "background-started" : "main-started";
    const seconds = text === "background-hold" ? 30 : 1;
    if (results.length === 0) tool("bash", { command: `printf started > ${marker}; sleep ${seconds}` });
    else message.content = [{ type: "text", text: "Original hold finished." }];
  } else if (text === "publish-background") {
    if (results.length === 0) tool("publish_to_chat", { text: "Useful background result" });
    else message.content = [{ type: "text", text: "Private execution details" }];
  } else if (text === "remember-preference") {
    if (results.length === 0) tool("write", { path: "MEMORY.md", content: "User prefers concise summaries." });
    else message.content = [{ type: "text", text: "Preference saved." }];
  } else if (text === "inspect-memory") {
    message.content = [{ type: "text", text: String(context.systemPrompt).includes("User prefers concise summaries.") ? "Shared memory loaded" : "Memory missing" }];
  } else if (text === "inspect-history") {
    const users = context.messages.filter((item: any) => item.role === "user");
    message.content = [{ type: "text", text: JSON.stringify(users) }];
  } else if (text === "steered-result") {
    message.content = [{ type: "text", text: "Native steering applied." }];
  }
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    stream.end();
  });
  return stream;
}
