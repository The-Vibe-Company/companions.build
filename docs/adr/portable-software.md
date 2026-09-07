# Portable software for client deliveries

Status: accepted security boundary; manifest, trusted resolvers, installer, and clean-builder helper
implemented; runtime snapshot and delivery integration pending.

## Context

An agent template includes its prepared software environment. Private templates can preserve that
environment by capturing a child Box directly. A client delivery cannot reuse that snapshot: it may
contain browser sessions, credentials, history, private files, or software configuration that no
general scanner can identify safely.

The current delivery path copies the profile, selected model, and validated local Pi skills into a
fresh Box created from the platform base. It does not transfer other software installed in the
source Box. A private snapshot without a portable manifest is therefore an unverified source
environment, not proof that the delivered copy is prepared.

The headless Pi process cannot bridge this gap itself. It runs as the unprivileged
`companions-agent` user with no capabilities, no sudo, a read-only root filesystem, and only its
agent state mounted writable. It may install local skills in that state. It cannot install system
packages or safely turn arbitrary writable files into a client image.

## Decision

Client software is rebuilt from a pinned declarative manifest in a fresh, credential-free build
Box. The builder never starts from the provider's Companion or its captured snapshot. It produces a
new immutable snapshot which delivered Companions and specialist templates can use with fresh
execution identities and client-owned connections.

The locked manifest has this logical shape:

```ts
type PackageId = string;
type PortableSoftwareManifestV1 = {
  version: 1;
  base: {
    id: string;                 // opaque platform identity
    distributionDigest: string; // lowercase SHA-256
    distro: {
      family: string;
      suite: string;
      architecture: string;
    };
  };
  apt: {
    roots: PackageId[];
    packages: Array<{
      id: PackageId;
      name: string;
      version: string;
      architecture: string;
      sha256: string;
      dependencies: PackageId[];
    }>;
  };
  npm: {
    roots: PackageId[];
    packages: Array<{
      id: PackageId;
      name: string;
      version: string;
      integrity: string; // sha512 SRI
      dependencies: PackageId[];
    }>;
  };
};
```

The actual distro family and suite come from a verified base-image probe. They are not hard-coded
to Debian or to a release name. The opaque base identity selects an immutable, platform-owned Box
base; `distributionDigest` binds its software distribution and provisioning helper. Distro values
use a short lowercase identifier grammar. Package names, versions, architectures, SHA-256 values,
SRI values, and package IDs each have strict ecosystem-specific grammars and length limits.

Every dependency edge names an entry in the same manifest. Roots and the complete resolved closure
are sorted, unique, target-specific, and bounded. npm versions are exact registry versions, never
ranges, tags, aliases, Git sources, or file references. Every npm archive has SHA-512 SRI. Every apt
package has an exact version, architecture, and `.deb` SHA-256 from the configured immutable,
signed repository snapshot. Unknown fields are rejected.

The manifest contains no URLs, shell commands, lifecycle scripts, environment variables, headers,
tokens, filesystem destinations, or provider snapshot names. npm lifecycle scripts are disabled.
Packages that require them are unsupported in version 1. Apt maintainer scripts remain trusted
distribution package content; only the configured signed repository snapshot is eligible, and no
user-provided maintainer script or repository is accepted.

Canonical JSON uses lexicographically sorted object keys and package/dependency arrays sorted by
ID. Its SHA-256 is stored with the template revision and delivery build. A template edit or rollback
creates or restores a complete profile, skill bundle, software manifest, and clean snapshot
revision together.

## Recording and building

A future product operation records desired public packages. It does not give Pi sudo and does not
claim the packages are installed. A trusted resolver converts that request into the closed locked
manifest above. Manual installs made through the desktop, language-manager state, arbitrary
binaries, and files outside portable skills remain private and unverified until they are expressed
and rebuilt through this contract. Source-Box inventory may suggest requirements to the user, but
it cannot automatically authorize a recipe or prove that the source contains no secrets.

The runtime lifecycle owner claims a durable build job, creates a Box from the pinned clean base,
and supplies no model, plugin, OAuth, browser, source-agent, or client credentials. A root-owned
helper baked into that base validates the manifest again and installs it using fixed argv,
the configured apt repository snapshot, and the configured public npm registry. Pi cannot invoke
this helper. npm installation uses lifecycle scripts disabled and a fixed product prefix. The
builder independently verifies the installed package closure and hashes before capturing the clean
snapshot.

Create, install, verify, snapshot, and cleanup each have a durable checkpoint and stable operation
identity. An ambiguous snapshot request is observed by its persisted name and is never submitted
blindly again. An invitation that promises prepared software remains pending until its clean
snapshot is confirmed. A failed build exposes a safe stable error and cannot be presented as ready.
Ordinary Companion wake-up performs no package installation.

## Required implementation

The implementation needs immutable manifest storage; manifest references on templates and template
revisions; delivery build rows pinned to the selected revision; a runtime-only build progression;
and final snapshot references on the delivered main Companion and copied specialist templates.
Delivery state must distinguish profile-and-skills readiness from clean-software readiness without
describing an unverified source snapshot as portable.

Acceptance must prove:

- validation rejects ranges, alternate registries, URLs, commands, environment values, unknown
  fields, incomplete closures, duplicate identities, bad hashes, and npm lifecycle requirements;
- the build starts from the registered base identity and never reads or references the source Box
  or source snapshot;
- no source, model, plugin, OAuth, browser, or client credential enters the build Box;
- declared packages are independently observed in a delivered Box, with no installer invocation on
  wake;
- two client deliveries have independent Boxes, files, connections, histories, and later changes;
- the selected template revision remains pinned across retries, edits, and rollbacks;
- failures around every provider effect recover without duplicate Boxes, installs, or snapshots;
- pending and failed builds never send or display a prepared-software success; and
- cleanup cannot delete a snapshot or manifest still referenced by a delivery or template revision.

Until the builder is wired into runtime snapshot creation and client delivery, profile, model, and
portable-skill delivery remains useful but is not evidence that arbitrary software from a prepared
source Box was transferred.

## Clean-builder staging contract

The root-only Linux helper accepts a stable build UUID, exact apt and npm roots, and a caller-provided
request digest. The digest must equal `portableSoftwareBuildRequestDigest(...)`, which binds the
roots to the immutable base descriptor and hashes of the operator-owned signed APT and public npm
configuration. Runtime integration should call this exported digest function rather than reproduce
its canonical JSON. API idempotency fingerprints remain a separate concern.

The helper writes one private journal under the operator-owned state directory. Its fixed phases are
`pending`, `resolving`, `resolved`, `installing`, `verifying`, `verified`, and `failed`. Journal
replacement and phase checkpoints are fsynced. A retry with the same UUID and digest observes or
resumes the journal; a changed digest is rejected. Resolution can be repeated after interruption.
An interrupted installation is first verified against the locked manifest: a fully installed result
advances without replay, while a partial result fails closed and requires a new clean build. A
terminal failure records only a stable error code.

The process must start with an allowlisted, credential-free environment and UID 0 on Linux. Repository
URLs and key material come only from trusted operator configuration; the request has no URL, command,
environment, source Box, snapshot, or credential field. Child processes receive a minimal environment
and fixed apt, dpkg, and npm argv. The helper does not run Pi or capture a provider snapshot. The later
runtime stage may snapshot only after the helper reports `verified`, then persist that provider effect
under its own durable observation and fencing contract.

The distribution build accepts the optional operator argument `--software-config <absolute-path>`.
Without it, the normal agent distribution is built unchanged and portable-software preparation is
unavailable. With it, the build compiles `/opt/companions/companion-software-builder` and emits a
canonical descriptor plus the public APT keyring. The immutable distribution digest binds the
ordinary agent files, compiled builder bytes, descriptor payload, and keyring bytes; the final
descriptor carries that digest without hashing itself recursively.

Runtime writes a root-owned mode-0600 request at
`/var/lib/companions-software/builds/<build-id>/request.json`, then invokes the fixed CLI as
`companion-software-builder run|status <build-id> <request-digest>`. The request contains only
`{version:1, aptRoots, npmRoots}`. Before installation, `run` refuses any Companion environment,
identity, or state in the clean Box and stops the exact Companion desktop, agent, and proxy units.
After verification it enables the baseline units without starting them and fsyncs a capture seal.
`readyForCapture` is true only when that seal, the helper journal, manifest digest, request digest,
and compiled distribution descriptor still agree. The runtime then retrieves the canonical public
export at `/tmp/companions-software-exports/<build-id>.manifest.json` through the bounded Box file
API, validates it, and records it; the private bundle path is never returned or persisted. Provider
snapshot capture remains a separate runtime checkpoint.

Errors before the build journal exists or after package verification are recorded atomically in the
root-owned build directory as `cli-failure.json`, bound to the request digest. A later `run` returns
that terminal result before touching services or packages. A valid `status` command remains read-only
and returns failed projections with exit code zero so provider command handling preserves the
structured error. A busy existing helper is transient and never writes this terminal outcome.

The operator registration command validates the completed locally owned template journal, archive
SHA-256, current descriptor, compiled builder and keyring hashes, and reconstructed distribution
digest before it calls the internal immutable-base registration and selection functions. It never
creates, names, or contacts a provider resource.
