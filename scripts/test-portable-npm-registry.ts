import { resolveNpmSoftware } from "../packages/box/software-resolve";

const resolved = await resolveNpmSoftware([{ name: "is-odd", version: "3.0.1" }], {
  registry: "https://registry.npmjs.org",
});
const ids = resolved.npm.packages.map(item => item.id);
if (JSON.stringify(ids) !== JSON.stringify(["is-number@6.0.0", "is-odd@3.0.1"])) throw new Error("Unexpected public registry closure");
console.log(`Verified ${ids.length} locked public npm packages and archives`);
