# QuickJS trigger-filter boundary

Date: 2026-09-07

## Decision

Use the pinned `quickjs-emscripten@0.32.0` release for trigger filters. Each evaluation creates a
new synchronous QuickJS runtime and context, installs no host APIs or module loader, copies only
bounded JSON into the guest, and disposes both objects before returning. This removes the worker's
Docker-daemon dependency without evaluating user code in Bun or Node's JavaScript realm.

The package's official usage guide documents that contexts have separate globals, runtimes own
their JavaScript heaps, and runtimes expose memory, stack, and interrupt limits. It also shows that
module loading is opt-in through `setModuleLoader`; the implementation does not configure one.
The dependency and its four WASM variants are locked to version 0.32.0 and integrity hashes in
`bun.lock`.

Sources:

- [quickjs-emscripten 0.32.0 source and usage guide](https://github.com/justjake/quickjs-emscripten/tree/v0.32.0)
- [QuickJS runtime API](https://github.com/justjake/quickjs-emscripten/blob/v0.32.0/doc/quickjs-emscripten-core/classes/QuickJSRuntime.md)
- [Published quickjs-emscripten 0.32.0 package](https://www.npmjs.com/package/quickjs-emscripten/v/0.32.0)

## Boundary

- `shouldTrigger(payload, responses)` remains the only contract and must return a boolean. Only
  exact `true` accepts.
- The host serializes the two inputs to at most 400,000 characters. QuickJS parses and recursively
  freezes that JSON before the filter runs. No host object or callback crosses into the guest.
- A fresh guest receives no Bun, Node, filesystem, environment, network, FFI, `require`, or module
  loader capability. Dynamic or static imports cannot resolve.
- Each runtime has a 16 MiB heap, a 512 KiB stack, and a 50 ms interpreter interrupt deadline.
  Host input and code limits remain 400,000 and 20,000 characters.
- Errors crossing the boundary are replaced with the stable `FilterExecutionError`; guest stack,
  source, and values are not logged or persisted.

QuickJS is still a native parser and interpreter compiled to WebAssembly. Pinning and reviewing
dependency updates remains necessary. The production container test executes a real filter inside
the final image so missing WASM assets or Bun loading incompatibility fail before deployment.
