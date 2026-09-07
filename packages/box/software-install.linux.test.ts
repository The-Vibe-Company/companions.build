import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileSoftwareBundle, detectLinuxBase, installSoftwareBundle, removeSoftwareBundle } from "./software-install";

test("reconstructs locked apt and npm software in a clean Linux builder", async () => {
  if (process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("software_linux_acceptance_requires_root_linux");
  const scratch = await mkdtemp(join(tmpdir(), "software-linux-"));
  const sentinel = "SOURCE_CREDENTIAL_SENTINEL_95c98a";
  try {
    const detected = await detectLinuxBase();
    const debRoot = join(scratch, "deb");
    await mkdir(join(debRoot, "DEBIAN"), { recursive: true });
    await mkdir(join(debRoot, "usr", "bin"), { recursive: true });
    await Bun.write(join(debRoot, "DEBIAN", "control"), `Package: companions-portable-hello\nVersion: 1.0-1\nArchitecture: ${detected.architecture}\nMaintainer: Companions <noreply@companions.build>\nDescription: portable software acceptance fixture\n`);
    await Bun.write(join(debRoot, "usr", "bin", "companions-portable-hello"), "#!/bin/sh\nprintf apt-ready\n");
    await chmod(join(debRoot, "usr", "bin", "companions-portable-hello"), 0o755);
    const debPath = join(scratch, "hello.deb");
    const debBuild = Bun.spawnSync(["dpkg-deb", "--build", debRoot, debPath], { stdout: "pipe", stderr: "pipe" });
    expect(debBuild.exitCode).toBe(0);

    const npmRoot = join(scratch, "npm", "package");
    await mkdir(npmRoot, { recursive: true });
    await Bun.write(join(npmRoot, "package.json"), JSON.stringify({ name: "companions-portable-tiny", version: "1.2.3", bin: { "companions-portable-tiny": "index.js" } }));
    await Bun.write(join(npmRoot, "index.js"), "#!/usr/bin/env node\nprocess.stdout.write('npm-ready')\n");
    await chmod(join(npmRoot, "index.js"), 0o755);
    const npmPath = join(scratch, "tiny.tgz");
    expect(Bun.spawnSync(["tar", "-czf", npmPath, "package"], { cwd: join(scratch, "npm") }).exitCode).toBe(0);
    const debBytes = new Uint8Array(await Bun.file(debPath).arrayBuffer());
    const npmBytes = new Uint8Array(await Bun.file(npmPath).arrayBuffer());
    const aptId = `companions-portable-hello:${detected.architecture}=1.0-1`;
    const npmId = "companions-portable-tiny@1.2.3";
    const manifest = {
      version: 1,
      base: { id: "acceptance-base", distributionDigest: "a".repeat(64), distro: detected },
      apt: { roots: [aptId], packages: [{ id: aptId, name: "companions-portable-hello", version: "1.0-1", architecture: detected.architecture, sha256: createHash("sha256").update(debBytes).digest("hex"), dependencies: [] }] },
      npm: { roots: [npmId], packages: [{ id: npmId, name: "companions-portable-tiny", version: "1.2.3", integrity: `sha512-${createHash("sha512").update(npmBytes).digest("base64")}`, dependencies: [], lifecycle: false }] },
    };
    const bundle = await compileSoftwareBundle({ manifest, detectedBase: detected, repositories: { aptOrigin: "https://snapshot.debian.org/archive/debian/20260907T000000Z", npmRegistry: "https://registry.npmjs.org" }, aptArtifacts: [{ packageId: aptId, bytes: debBytes }], npmArtifacts: [{ packageId: npmId, bytes: npmBytes }] });
    await installSoftwareBundle(bundle, { npmPrefix: "/opt/companions/software" });
    expect(Bun.spawnSync(["companions-portable-hello"], { stdout: "pipe" }).stdout.toString()).toBe("apt-ready");
    expect(Bun.spawnSync(["/opt/companions/software/bin/companions-portable-tiny"], { stdout: "pipe" }).stdout.toString()).toBe("npm-ready");
    const installed = `${await readFile("/usr/bin/companions-portable-hello", "utf8")} ${await readFile("/opt/companions/software/lib/node_modules/companions-portable-tiny/index.js", "utf8")}`;
    expect(installed).not.toContain(sentinel);
    await removeSoftwareBundle(bundle);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 120_000);
