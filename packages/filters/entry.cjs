"use strict";
const vm = require("node:vm");

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

let source = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  source += chunk;
  if (source.length > 400_000) process.exit(65);
});
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(source);
    if (typeof input.code !== "string" || input.code.length > 20_000) throw new Error("invalid_code");
    const context = vm.createContext({ payload: freeze(input.payload), responses: freeze(input.responses), result: false }, {
      codeGeneration: { strings: false, wasm: false }, name: "companion-trigger-filter",
    });
    new vm.Script(`"use strict";\n${input.code}\n;if(typeof shouldTrigger!=="function")throw new Error("missing_function")`, {
      filename: "trigger-filter.js",
    }).runInContext(context, { timeout: 50 });
    new vm.Script("result = shouldTrigger(payload, responses) === true", { filename: "trigger-call.js" })
      .runInContext(context, { timeout: 50 });
    process.stdout.write(JSON.stringify({ accepted: context.result === true }));
  } catch {
    process.stdout.write(JSON.stringify({ error: "filter_failed" }));
    process.exitCode = 1;
  }
});
