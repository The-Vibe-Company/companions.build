import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SoftwareBoxMachines, type SoftwareBoxBuild } from "../src/software-box";
import { canonicalJson, softwareDistributionDescriptorPayload } from "../../../packages/box/software-distribution";
import { portableSoftwareBuildRequestDigestFromHashes } from "../../../packages/box/software-build";
import { BoxClient } from "../../../packages/box/client";

const buildId = "790b5c48-cb73-44e2-978f-8feff575f9a8";
const keyring = new TextEncoder().encode("public-keyring");
const config = { version: 1 as const, base: { id: "ubuntu-noble-v10", distro: { family: "ubuntu", suite: "noble", architecture: "amd64" } },
  aptRepository: { family: "ubuntu", snapshot: "20260901T000000Z", architecture: "amd64", keyringPath: "/operator/keyring.gpg",
    sources: [{ origin: "https://snapshot.ubuntu.com/ubuntu/20260901T000000Z", suite: "noble", components: ["main"], inReleaseSha256: "a".repeat(64) }] }, npmRegistry: "https://registry.npmjs.org" };
const payload = softwareDistributionDescriptorPayload(config, keyring, new TextEncoder().encode("builder"));
const descriptor = { ...payload, base: { ...payload.base, distributionDigest: "b".repeat(64) } };
const baseBuild: SoftwareBoxBuild = { id: buildId, ownerId: "owner", templateId: crypto.randomUUID(), createKey: crypto.randomUUID(), boxId: "bx_23456789",
  snapshotName: `companions-software-${buildId}`, roots: { apt: [], npm: [{ name: "is-number", version: "7.0.0" }] }, helperRequestDigest: null,
  base: { id: descriptor.base.id, providerSnapshotName: "companions-agent-v10", distributionDigest: descriptor.base.distributionDigest,
    resolverConfigDigest: descriptor.resolverConfigDigest, distro: descriptor.base.distro } };
const context = () => ({ signal: new AbortController().signal, asserted: 0, async assertActive() { this.asserted++; } });

class FakeBox {
  calls: Array<{ method: string; args: unknown[] }> = []; files = new Map<string, string>(); status: unknown = null; launchFails = false;
  async create(...args: unknown[]) { this.calls.push({ method: "create", args }); return { id: "bx_abcdefgh", state: "ready" }; }
  async get(...args: unknown[]) { this.calls.push({ method: "get", args }); return { id: args[0], state: "ready" }; }
  async resume(...args: unknown[]) { this.calls.push({ method: "resume", args }); }
  async writeFile(_id: string, path: string, content: string) { this.calls.push({ method: "writeFile", args: [_id, path, content] }); this.files.set(path, content); }
  async readFile(_id: string, path: string, maximum: number) { this.calls.push({ method: "readFile", args: [_id, path, maximum] });
    if (path.endsWith("distribution.json")) return `${canonicalJson(descriptor)}\n`;
    return JSON.stringify({ version: 1, base: descriptor.base, apt: { roots: [], packages: [] }, npm: { roots: [], packages: [] } }); }
  async command(_id: string, command: string, timeout: number) { this.calls.push({ method: "command", args: [_id, command, timeout] });
    if (command.includes("/systemd-run ") && this.launchFails) throw new Error("ambiguous");
    if (command.includes(" status ")) return JSON.stringify(this.status);
    return ""; }
  async snapshot(...args: unknown[]) { this.calls.push({ method: "snapshot", args }); }
  async getSnapshot(...args: unknown[]) { this.calls.push({ method: "getSnapshot", args }); return { snapshot: { status: "ready" } }; }
  async stop(...args: unknown[]) { this.calls.push({ method: "stop", args }); }
}

describe("software Box adapter", () => {
  test("reads bounded public exports through the Box file endpoint", async () => {
    let requested = "";
    const client = new BoxClient("test-key", (async url => { requested = String(url); return Response.json({ success: true, encoding: "utf8", size: 3, content: "{}\n" }); }) as typeof fetch, "https://box.invalid/v1");
    expect(await client.readFile("bx_23456789", "/tmp/companions-software-exports/result.json", 1024)).toBe("{}\n");
    const url = new URL(requested);
    expect(url.pathname).toBe("/v1/boxes/bx_23456789/files");
    expect(url.searchParams.get("path")).toBe("/tmp/companions-software-exports/result.json");
  });

  test("creates from the registered clean base and stages only canonical public roots", async () => {
    const box = new FakeBox(), machines = new SoftwareBoxMachines(box as any), active = context();
    expect(await machines.create(baseBuild, active)).toEqual({ id: "bx_abcdefgh" });
    expect(box.calls[0]).toEqual({ method: "create", args: [baseBuild.createKey, "companions-agent-v10"] });
    const prepared = await machines.prepareHelper(baseBuild, active);
    const uploaded = box.calls.find(call => call.method === "writeFile")!;
    expect(uploaded.args[1]).toBe(`/tmp/companions-software-request-${buildId}.json`);
    expect(JSON.parse(String(uploaded.args[2]))).toEqual({ version: 1, aptRoots: [], npmRoots: [{ name: "is-number", version: "7.0.0" }] });
    expect(String(uploaded.args[2])).not.toMatch(/owner|token|env|snapshot/i);
    expect(prepared.requestDigest).toBe(portableSoftwareBuildRequestDigestFromHashes({ aptRoots: [], npmRoots: baseBuild.roots.npm }, descriptor.base,
      { ...descriptor.aptRepository, keyringSha256: descriptor.keyringSha256 }, descriptor.npmRegistry));
    expect(active.asserted).toBeGreaterThanOrEqual(4);
  });

  test("rejects a descriptor that does not match the DB-pinned base before uploading", async () => {
    const box = new FakeBox(), machines = new SoftwareBoxMachines(box as any);
    await expect(machines.prepareHelper({ ...baseBuild, base: { ...baseBuild.base, distributionDigest: "c".repeat(64) } }, context())).rejects.toThrow("software_descriptor_base_mismatch");
    expect(box.calls.some(call => call.method === "writeFile")).toBe(false);
  });

  test("reconciles an ambiguous stable-unit launch through the durable helper status", async () => {
    const box = new FakeBox(); box.launchFails = true;
    const requestDigest = "d".repeat(64); box.status = { phase: "installing", requestDigest, manifestDigest: "e".repeat(64), errorCode: null, revision: 4, readyForCapture: false };
    const machines = new SoftwareBoxMachines(box as any, { sleep: async () => {} });
    const result = await machines.runHelper({ ...baseBuild, helperRequestDigest: requestDigest }, context());
    expect(result).toMatchObject({ phase: "installing", requestDigest, readyForCapture: false });
    const launch = box.calls.find(call => call.method === "command" && String(call.args[1]).includes("/systemd-run "))!;
    expect(String(launch.args[1])).toContain(`--unit=companions-software-build-${buildId.replaceAll("-", "")}`);
    expect(String(launch.args[1])).toContain("/usr/bin/env -i HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8");
  });
});

const temporary: string[] = [];
afterAll(async () => Promise.all(temporary.map(path => rm(path, { recursive: true, force: true }))));

test.skipIf(process.env.RUN_LOCAL_ACCEPTANCE !== "1")("compiled CLI installs and seals an empty manifest in pinned Ubuntu", async () => {
  const directory = await mkdtemp(join(tmpdir(), "software-box-linux-")); temporary.push(directory);
  const executable = join(directory, "companion-software-builder");
  const built = Bun.spawnSync([process.execPath, "build", "--compile", "--target=bun-linux-x64-baseline", "packages/box/software-builder-cli.ts", "--outfile", executable], { stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  expect(built.exitCode, new TextDecoder().decode(built.stderr)).toBe(0);
  const binary = new Uint8Array(await readFile(executable));
  const linuxPayload = softwareDistributionDescriptorPayload(config, keyring, binary);
  const linuxDescriptor = { ...linuxPayload, base: { ...linuxPayload.base, distributionDigest: "b".repeat(64) } };
  await Promise.all([writeFile(join(directory, "software-builder.json"), `${canonicalJson(linuxDescriptor)}\n`), writeFile(join(directory, "software-apt-keyring.gpg"), keyring)]);
  const request = { aptRoots: [], npmRoots: [] };
  const requestDigest = portableSoftwareBuildRequestDigestFromHashes(request, linuxDescriptor.base,
    { ...linuxDescriptor.aptRepository, keyringSha256: linuxDescriptor.keyringSha256 }, linuxDescriptor.npmRegistry);
  await writeFile(join(directory, "request.json"), JSON.stringify({ version: 1, ...request }));
  const script = `set -eu
mkdir -p /opt/companions /var/lib/companions-software/builds/${buildId}
cp /input/companion-software-builder /input/software-builder.json /input/software-apt-keyring.gpg /opt/companions/
cp /input/request.json /var/lib/companions-software/builds/${buildId}/request.json
chmod 700 /opt/companions/companion-software-builder /var/lib/companions-software/builds /var/lib/companions-software/builds/${buildId}
chmod 600 /var/lib/companions-software/builds/${buildId}/request.json
printf '#!/bin/sh\\ncase "$1" in is-active) exit 3;; *) exit 0;; esac\\n' > /usr/bin/systemctl
chmod 755 /usr/bin/systemctl
test ! -e /home/user/.companions.env
test ! -e /home/user/.companions
env -i HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 /opt/companions/companion-software-builder run ${buildId} ${requestDigest} > /result.json
grep -q '"readyForCapture":true' /result.json
test -s /tmp/companions-software-exports/${buildId}.manifest.json
test ! -e /home/user/.companions.env
test ! -e /home/user/.companions
`;
  const result = Bun.spawnSync(["docker", "run", "--rm", "--platform", "linux/amd64", "-v", `${directory}:/input:ro`,
    "ubuntu:24.04@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517", "/bin/sh", "-c", script], { stdout: "pipe", stderr: "pipe", timeout: 180_000 });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
});
