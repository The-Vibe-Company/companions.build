import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";

export const FILTER_TIMEOUT_MS = 50;
export const FILTER_MEMORY_LIMIT_BYTES = 16 * 1024 * 1024;
export const FILTER_STACK_LIMIT_BYTES = 512 * 1024;
const FILTER_CODE_LIMIT = 20_000;
const FILTER_INPUT_LIMIT = 400_000;

export class FilterExecutionError extends Error {
  constructor(message = "The trigger filter could not be evaluated.") { super(message); }
}

export interface FilterInput { code: string; payload: unknown; responses?: Record<string, unknown> }

function programFor(input: FilterInput): string {
  let serialized: string;
  try {
    serialized = JSON.stringify({ payload: input.payload, responses: input.responses ?? {} });
  } catch {
    throw new FilterExecutionError();
  }
  if (serialized.length > FILTER_INPUT_LIMIT) throw new FilterExecutionError();

  // Parse and freeze the JSON inside QuickJS. No host objects or callbacks cross the boundary.
  const encodedInput = JSON.stringify(serialized);
  return `"use strict";
(() => {
  const input = JSON.parse(${encodedInput});
  const pending = [input];
  while (pending.length) {
    const value = pending.pop();
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      for (const key of Object.keys(value)) pending.push(value[key]);
      Object.freeze(value);
    }
  }
  ${input.code}
  if (typeof shouldTrigger !== "function") throw new TypeError("shouldTrigger must be a function");
  const accepted = shouldTrigger(input.payload, input.responses);
  if (typeof accepted !== "boolean") throw new TypeError("shouldTrigger must return a boolean");
  return accepted;
})()`;
}

export async function runFilter(input: FilterInput): Promise<boolean> {
  try {
    if (typeof input.code !== "string" || !input.code.trim() || input.code.length > FILTER_CODE_LIMIT) {
      throw new FilterExecutionError();
    }
    const source = programFor(input);

    const QuickJS = await getQuickJS();
    const runtime = QuickJS.newRuntime();
    try {
      runtime.setMemoryLimit(FILTER_MEMORY_LIMIT_BYTES);
      runtime.setMaxStackSize(FILTER_STACK_LIMIT_BYTES);
      runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + FILTER_TIMEOUT_MS));
      const context = runtime.newContext();
      try {
        const result = context.evalCode(source, "trigger-filter.js", { type: "global", strict: true });
        if (result.error) {
          result.error.dispose();
          throw new FilterExecutionError();
        }
        return result.value.consume(handle => {
          if (context.typeof(handle) !== "boolean") throw new FilterExecutionError();
          return context.dump(handle) as boolean;
        });
      } finally {
        context.dispose();
      }
    } finally {
      runtime.dispose();
    }
  } catch (error) {
    if (error instanceof FilterExecutionError) throw error;
    throw new FilterExecutionError();
  }
}
