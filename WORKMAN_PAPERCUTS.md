# Workman papercuts found while building gpuman

This document records unresolved issues encountered while building gpuman. Fixed items are removed
after gpuman adopts the corresponding Workman behavior. The remaining examples distinguish compiler
bugs, tooling cleanup gaps, and intentional language restrictions.

## Summary

| Area | Classification | Effect on gpuman |
| --- | --- | --- |
| Foreign receiver through a record | Open inference/FFI bug | Requires a typed local before WebGPU member access. |
| No module re-export | Intentional restriction | Facade duplicates nominal public types and converts them. |
| Forced `wm run` termination | Tooling cleanup gap | Leaves `.wm-mini-*` directories beside the entrypoint. |
| Delayed-FFI diagnostic collapse | Diagnostic quality bug | `wm check` can report only `from generated: unknown`. |

## 1. Foreign receiver evidence is lost through a nominal record projection

### Minimal reproduction

```wm
from js.global import type { GPUDevice };

record Box = { device: GPUDevice };

let queue = (box: Box) => {
  box.device.queue
};
```

### Observed behavior

```text
error: GPUDevice is not a record type
  box.device.queue
  ^^^^^^^^^^^^^^^^
```

The first projection is a Workman nominal-record projection. The second is a reflected JavaScript
member access. The delayed FFI resolver appears to reinterpret the intermediate `GPUDevice` as a
Workman record receiver instead of retaining its foreign receiver identity.

### Expected behavior

The inferred type of `box.device` is already the reflected foreign `GPUDevice`. Member lookup for
`.queue` should therefore use TypeScript/WebGPU reflection exactly as it does for a direct
`device: GPUDevice` parameter.

### Current workaround

Materialize an explicitly typed local before the foreign access:

```wm
let queue = (box: Box) => {
  let device: GPUDevice = box.device;
  device.queue
};
```

gpuman needs this pattern in pipeline and renderer code. This belongs to the same family as the
existing open wm-mini note
`markdown/issues/webgpu-foreign-receiver-evidence-through-task-option.md`, but the reproducer here is
smaller: it requires neither `Task` nor `Option`, only a nominal record field.

### Suggested regression

Cover foreign receivers nested beneath each ordinary Workman container: nominal record, tuple,
`Option`, `Result`, `Task`, and an ADT payload. Each extracted receiver should resolve the same
member as a directly annotated receiver without a local restatement.

## 2. A facade cannot re-export imported public identities

Workman's module protocol intentionally says imports are working scope only and are never
re-exported. There is also no forwarding syntax. Consequently this module:

```wm
from "./render.wm" import * as Render;
```

cannot make `Render.Renderer` available as `GpuMan.Renderer`, nor can it forward constructors such
as `SdlWindow.Continue` as `GpuMan.Continue`.

### Impact on gpuman

The single-import facade has to declare new nominal types:

- `GpuMan.Renderer` wrapping `Render.Renderer`;
- `GpuMan.Pixels` wrapping `Readback.Pixels`;
- `GpuMan.WindowConfig`, `WindowApp`, `WindowEvent`, and `WindowStep`;
- conversion functions between the facade and focused SDL modules.

This is safe and explicit, but it adds allocation/wrapper code and creates two public type families
for the same conceptual values.

### Possible language direction

A future explicit forwarding form could preserve the original semantic identity instead of
re-elaborating or aliasing it. It must work independently in the structure, type, value, and
constructor namespaces; a JavaScript-style textual `export *` would not fit Workman's module
identity rules. Until that exists, duplicate facade types are the correct workaround.

## 3. Force-killing `wm run` leaks sibling `.wm-mini-*` directories

`wm run examples/window.wm` creates a temporary directory beside the entrypoint:

```text
examples/.wm-mini-<random>/main.mjs
```

Normal return executes `runFile`'s `finally` block and calls `temporaryDirectory.cleanup()`. Sending
SIGTERM to the `wm` parent—for example `timeout 3s wm run examples/window.wm`—terminates it before
that `finally` block can remove the directory. Repeated interactive smoke tests therefore accumulate
one directory per run.

### Impact and corrected test practice

Four directories accumulated while gpuman's infinite window example was tested under `timeout`.
They were moved to trash. The SDL window API now lets `advance` return `Exit`, so gpuman tests use a
finite state machine and allow `wm run` to return normally. A finite real-SDL probe confirmed that no
temporary directory remains.

### Possible tooling fixes

- Install scoped signal handlers while a run is active, terminate the child, await it, then clean
  the bound temporary-directory capability before exiting.
- On startup, safely identify and remove stale `.wm-mini-*` directories that match the tool's own
  manifest/ownership marker. Prefix matching alone is not sufficient proof of ownership.
- Consider a system temp root if emitted relative imports can be mapped back to source dependencies.

The existing `TemporaryDirectory` capability is appropriately path-bound and idempotent; the gap is
process termination, not ordinary cleanup.

## 4. Delayed-FFI failures can collapse to `from generated: unknown`

While implementing readback, `wm check` repeatedly surfaced only:

```text
error[type.mismatch /path/readback.wm]: type mismatch
support:
  cl3 claim: type mismatch
    from generated: unknown
```

Running `wm type-debug` on the same file exposed the useful underlying obligation, for example:

```text
cannot pipe unresolved JS FFI result before FFI reflection resolves the member access:
?ffi#4:beginRenderPass @ 56:14
```

Typed narrow helpers (`beginPass`, `setPipeline`, `copyToBuffer`, `submit`) allowed reflection to
resolve and are reasonable library boundaries. The user-facing checker should still report the
source member access and its unresolved receiver/result constraints instead of a generated unknown
location.

The existing fixed note
`markdown/issues/FIXED-type-debug-stops-on-recoverable-ffi-diagnostic.md` improved `type-debug`
itself. The remaining issue is promotion of that evidence into normal `wm check` diagnostics.

## Recommended priority

1. Preserve foreign receiver evidence through nominal record fields, extending the existing WebGPU
   receiver issue and removing repeated typed-local bridges.
2. Promote delayed-FFI evidence into normal diagnostics.
3. Make `wm run` signal cleanup robust.
4. Treat explicit re-export as deliberate language/API design work rather than a local compiler
   patch.
