import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAptSoftware } from "./software-resolve-apt";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))));

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "apt-resolver-test-")); dirs.push(directory);
  const status = join(directory, "base-status");
  await Bun.write(status, "Package: libc6\nStatus: install ok installed\nArchitecture: amd64\nVersion: 2.39-0ubuntu8\n\n");
  const release = new TextEncoder().encode("signed immutable release");
  const debs: Record<string, { bytes: Uint8Array; fields: Record<string, string> }> = {
    app: { bytes: new TextEncoder().encode("app deb"), fields: { Package: "portable-app", Version: "1.0-1", Architecture: "amd64", Depends: "portable-helper (= 1.0-1), libc6 (>= 2.0)", "Pre-Depends": "" } },
    helper: { bytes: new TextEncoder().encode("helper deb"), fields: { Package: "portable-helper", Version: "1.0-1", Architecture: "amd64", Depends: "", "Pre-Depends": "" } },
  };
  const commands: string[][] = [];
  const run = async (argv: string[]) => {
    commands.push(argv);
    if (argv[0] === "apt-get" && argv.at(-1) === "update") {
      await mkdir(join(directory, "lists"), { recursive: true }); await Bun.write(join(directory, "lists", "snapshot_InRelease"), release);
    } else if (argv[0] === "apt-get" && argv.includes("install")) {
      await mkdir(join(directory, "archives"), { recursive: true });
      await Bun.write(join(directory, "archives", "app.deb"), debs.app.bytes); await Bun.write(join(directory, "archives", "helper.deb"), debs.helper.bytes);
    }
    if (argv[0] === "dpkg-deb") {
      const key = argv[2].endsWith("app.deb") ? "app" : "helper"; const field = argv[3];
      return result(debs[key].fields[field] ?? "");
    }
    if (argv[0] === "apt-cache") {
      const spec = argv.at(-1)!; const item = spec.startsWith("portable-app:") ? debs.app : debs.helper;
      return result(`Package: ${item.fields.Package}\nVersion: ${item.fields.Version}\nArchitecture: ${item.fields.Architecture}\nSHA256: ${createHash("sha256").update(item.bytes).digest("hex")}\n`);
    }
    if (argv[0] === "dpkg" && argv[1] === "--compare-versions") return result("", 0);
    return result("");
  };
  return { directory, status, release, debs, commands, run };
}

function result(stdout = "", exitCode = 0) { return { exitCode, stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array() }; }

describe("trusted apt resolver", () => {
  test("uses apt's authenticated solver and preserves dependencies satisfied by the actual base", async () => {
    const f = await fixture();
    const resolved = await resolveAptSoftware([{ name: "portable-app", version: "1.0-1" }], {
      platform: "linux", getuid: () => 0, builder: true, directory: f.directory, baseStatusPath: f.status, run: f.run,
      base: { family: "ubuntu", suite: "noble", architecture: "amd64" },
      repository: { family: "ubuntu", snapshot: "20260907T000000Z", architecture: "amd64", keyring: new Uint8Array([1, 2]), sources: [{ origin: "https://snapshot.ubuntu.com/ubuntu/20260907T000000Z", suite: "noble", components: ["main"], inReleaseSha256: createHash("sha256").update(f.release).digest("hex") }] },
    });
    expect(resolved.apt.roots).toEqual(["portable-app:amd64=1.0-1"]);
    expect(resolved.apt.packages.map(item => item.id)).toEqual(["portable-app:amd64=1.0-1", "portable-helper:amd64=1.0-1"]);
    expect(resolved.apt.packages[0].dependencies).toEqual(["portable-helper:amd64=1.0-1"]);
    expect(resolved.baseDependencies).toEqual([{ id: "libc6:amd64=2.39-0ubuntu8", name: "libc6", version: "2.39-0ubuntu8", architecture: "amd64" }]);
    expect(resolved.aptArtifacts).toHaveLength(2);
    const apt = f.commands.filter(command => command[0] === "apt-get");
    expect(apt.every(command => !command.includes("--snapshot"))).toBe(true);
    expect(apt.flat().some(arg => /allow-unauthenticated|trusted=yes/i.test(arg))).toBe(false);
    expect(apt.flat()).toContain("Dir::Etc::netrc=-");
  });

  test("fails closed outside the builder and on release or base drift", async () => {
    const f = await fixture();
    const common: any = { platform: "linux", getuid: () => 0, builder: true, directory: f.directory, baseStatusPath: f.status, run: f.run, base: { family: "ubuntu", suite: "noble", architecture: "amd64" }, repository: { family: "ubuntu", snapshot: "20260907T000000Z", architecture: "amd64", keyring: new Uint8Array([1]), sources: [{ origin: "https://snapshot.ubuntu.com/ubuntu/20260907T000000Z", suite: "noble", components: ["main"], inReleaseSha256: "0".repeat(64) }] } };
    await expect(resolveAptSoftware([{ name: "portable-app", version: "1.0-1" }], { ...common, builder: false })).rejects.toThrow("software_apt_isolated_builder_required");
    await expect(resolveAptSoftware([{ name: "portable-app", version: "1.0-1" }], { ...common, repository: { ...common.repository, sources: [{ ...common.repository.sources[0], origin: "https://archive.ubuntu.com/ubuntu" }] } })).rejects.toThrow("software_apt_snapshot_not_immutable");
    await expect(resolveAptSoftware([{ name: "portable-app", version: "1.0-1" }], common)).rejects.toThrow("software_apt_release_mismatch");
    await expect(resolveAptSoftware([{ name: "portable-app", version: "1.0-1" }], { ...common, base: { ...common.base, suite: "jammy" } })).rejects.toThrow("software_base_mismatch");
  });
});
