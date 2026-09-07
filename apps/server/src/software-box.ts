import { z } from "zod";
import { BoxClient, BoxError } from "../../../packages/box/client";
import { portableSoftwareBuildRequestDigestFromHashes } from "../../../packages/box/software-build";
import { softwareDistributionDescriptorSchema } from "../../../packages/box/software-distribution";
import { validatePortableSoftwareManifest } from "../../../packages/control/software";

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const snapshotName = z.string().min(1).max(60).regex(/^[a-z0-9][a-z0-9-]*$/);
const boxId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const aptRoot = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9+.-]{0,127}$/), version: z.string().min(1).max(192) }).strict();
const npmRoot = z.object({ name: z.string().regex(/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/), version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/) }).strict();
const rootsSchema = z.object({ apt: z.array(aptRoot).max(32), npm: z.array(npmRoot).max(32) }).strict();
const helperSchema = z.object({ phase: z.enum(["pending", "resolving", "resolved", "installing", "verifying", "verified", "failed"]),
  requestDigest: digest, manifestDigest: digest.nullable(), errorCode: z.string().regex(/^software_[a-z0-9_:.-]{1,160}$/).nullable(),
  revision: z.number().int().nonnegative(), readyForCapture: z.boolean() }).passthrough();

const DESCRIPTOR_EXPORT = "/tmp/companions-software-exports/distribution.json";
const MANIFEST_EXPORT = (id: string) => `/tmp/companions-software-exports/${id}.manifest.json`;
const BUILD_DIRECTORY = (id: string) => `/var/lib/companions-software/builds/${id}`;
const CLEAN_ENV = "HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8";

export type SoftwareBoxBuild = {
  id: string; ownerId: string; templateId: string; createKey: string; boxId: string | null; snapshotName: string;
  roots: { apt: Array<{ name: string; version: string }>; npm: Array<{ name: string; version: string }> };
  helperRequestDigest: string | null;
  base: { id: string; providerSnapshotName: string; distributionDigest: string; resolverConfigDigest: string;
    distro: { family: string; suite: string; architecture: string } };
};
export type SoftwareBoxEffectContext = { signal: AbortSignal; assertActive(): Promise<void> };

type BoxTransport = Pick<BoxClient, "create" | "get" | "resume" | "command" | "writeFile" | "readFile" | "snapshot" | "getSnapshot" | "stop">;
type AdapterOptions = { sleep?: (milliseconds: number) => Promise<void> };

function check(context: SoftwareBoxEffectContext) { context.signal.throwIfAborted(); }
function requireBox(build: SoftwareBoxBuild) { return boxId.parse(build.boxId); }
function safeJson(text: string, maximum: number, code: string) {
  if (Buffer.byteLength(text, "utf8") > maximum) throw new Error(code);
  try { return JSON.parse(text); } catch { throw new Error(code); }
}

export class SoftwareBoxMachines {
  constructor(private box: BoxTransport, private options: AdapterOptions = {}) {}

  async create(build: SoftwareBoxBuild, context: SoftwareBoxEffectContext) {
    check(context); await context.assertActive();
    const created = await this.box.create(uuid.parse(build.createKey), snapshotName.parse(build.base.providerSnapshotName));
    check(context); return { id: boxId.parse(created.id) };
  }

  async get(build: SoftwareBoxBuild, context: SoftwareBoxEffectContext) {
    check(context);
    try {
      const machine = await this.box.get(requireBox(build)); check(context);
      if (machine.state === "archived") return { state: "archived" as const };
      if (["ready", "idle"].includes(machine.state)) return { state: "ready" as const };
      return { state: "starting" as const };
    } catch (error) { if (error instanceof BoxError && error.status === 404) return { state: "missing" as const }; throw error; }
  }

  async resume(build: SoftwareBoxBuild, context: SoftwareBoxEffectContext) {
    check(context); await context.assertActive(); await this.box.resume(requireBox(build)); check(context);
  }

  private async descriptor(build: SoftwareBoxBuild, context: SoftwareBoxEffectContext) {
    const id = requireBox(build); check(context); await context.assertActive();
    await this.box.command(id, "sudo -n /usr/bin/install -d -o root -g root -m 0755 /tmp/companions-software-exports && sudo -n /usr/bin/install -o root -g root -m 0644 /opt/companions/software-builder.json /tmp/companions-software-exports/distribution.json", 30);
    check(context);
    const raw = await this.box.readFile(id, DESCRIPTOR_EXPORT, 64 * 1024); check(context);
    const descriptor = softwareDistributionDescriptorSchema.parse(safeJson(raw, 64 * 1024, "software_descriptor_invalid"));
    const expected = build.base;
    if (descriptor.base.id !== expected.id || descriptor.base.distributionDigest !== expected.distributionDigest
      || descriptor.resolverConfigDigest !== expected.resolverConfigDigest
      || descriptor.base.distro.family !== expected.distro.family || descriptor.base.distro.suite !== expected.distro.suite
      || descriptor.base.distro.architecture !== expected.distro.architecture) throw new Error("software_descriptor_base_mismatch");
    return descriptor;
  }

  async prepareHelper(build: SoftwareBoxBuild, context: SoftwareBoxEffectContext) {
    const id = requireBox(build), buildId = uuid.parse(build.id), roots = rootsSchema.parse(build.roots);
    const descriptor = await this.descriptor(build, context);
    const request = { version: 1 as const, aptRoots: roots.apt, npmRoots: roots.npm };
    const requestDigest = portableSoftwareBuildRequestDigestFromHashes(request, descriptor.base,
      { ...descriptor.aptRepository, keyringSha256: descriptor.keyringSha256 }, descriptor.npmRegistry);
    const temporary = `/tmp/companions-software-request-${buildId}.json`;
    check(context); await context.assertActive();
    await this.box.writeFile(id, temporary, `${JSON.stringify(request)}\n`); check(context);
    await context.assertActive();
    await this.box.command(id, `sudo -n /usr/bin/install -d -o root -g root -m 0700 /var/lib/companions-software/builds ${BUILD_DIRECTORY(buildId)} && sudo -n /usr/bin/install -o root -g root -m 0600 ${temporary} ${BUILD_DIRECTORY(buildId)}/request.json && /usr/bin/rm -f ${temporary}`, 30);
    check(context); return { requestDigest };
  }

  private async status(build: SoftwareBoxBuild, context: SoftwareBoxEffectContext) {
    const id = requireBox(build), buildId = uuid.parse(build.id), requestDigest = digest.parse(build.helperRequestDigest);
    check(context); await context.assertActive();
    const output = await this.box.command(id, `sudo -n /usr/bin/env -i ${CLEAN_ENV} /opt/companions/companion-software-builder status ${buildId} ${requestDigest}`, 30);
    check(context);
    const parsed = safeJson(output, 16 * 1024, "software_helper_status_invalid");
    if (parsed === null) return null;
    const value = helperSchema.parse(parsed);
    return { phase: value.phase, requestDigest: value.requestDigest, manifestDigest: value.manifestDigest,
      errorCode: value.errorCode, revision: value.revision, readyForCapture: value.readyForCapture };
  }

  statusHelper(build: SoftwareBoxBuild, context: SoftwareBoxEffectContext) { return this.status(build, context); }

  async runHelper(build: SoftwareBoxBuild, context: SoftwareBoxEffectContext) {
    const id = requireBox(build), buildId = uuid.parse(build.id), requestDigest = digest.parse(build.helperRequestDigest);
    const unit = `companions-software-build-${buildId.replaceAll("-", "")}`;
    check(context); await context.assertActive();
    try {
      await this.box.command(id, `sudo -n /usr/bin/systemd-run --unit=${unit} --collect --property=Type=exec --property=TimeoutStartSec=30s --property=RuntimeMaxSec=30min /usr/bin/env -i ${CLEAN_ENV} /opt/companions/companion-software-builder run ${buildId} ${requestDigest}`, 30);
    } catch {
      // A lost reply or an already-active stable unit is resolved only through the helper journal.
    }
    const sleep = this.options.sleep ?? (milliseconds => Bun.sleep(milliseconds));
    for (let attempt = 0; attempt < 4; attempt++) {
      const observed = await this.status(build, context);
      if (observed !== null) return observed;
      if (attempt < 3) await sleep(250);
    }
    throw new Error("software_helper_launch_unresolved");
  }

  async readManifest(build: SoftwareBoxBuild, context: SoftwareBoxEffectContext) {
    const id = requireBox(build), buildId = uuid.parse(build.id); check(context);
    const raw = await this.box.readFile(id, MANIFEST_EXPORT(buildId), 8 * 1024 * 1024); check(context);
    return validatePortableSoftwareManifest(safeJson(raw, 8 * 1024 * 1024, "software_manifest_invalid"));
  }

  async snapshot(build: SoftwareBoxBuild, context: SoftwareBoxEffectContext) {
    check(context); await context.assertActive(); await this.box.snapshot(requireBox(build), snapshotName.parse(build.snapshotName)); check(context);
  }

  async getSnapshot(build: SoftwareBoxBuild, context: SoftwareBoxEffectContext) {
    check(context);
    try {
      const raw = await this.box.getSnapshot(snapshotName.parse(build.snapshotName)); check(context);
      const state = raw?.snapshot?.status ?? raw?.namedSnapshot?.status ?? raw?.status;
      if (state === "ready") return { state: "ready" as const };
      if (state === "failed") return { state: "failed" as const };
      return { state: "pending" as const };
    } catch (error) { if (error instanceof BoxError && error.status === 404) return { state: "missing" as const }; throw error; }
  }

  async archive(build: SoftwareBoxBuild, context: SoftwareBoxEffectContext) {
    check(context); await context.assertActive(); await this.box.stop(requireBox(build)); check(context);
  }
}

export function createSoftwareBoxMachines(boxKey: string) {
  if (!boxKey) throw new Error("software_box_key_required");
  return new SoftwareBoxMachines(new BoxClient(boxKey));
}
