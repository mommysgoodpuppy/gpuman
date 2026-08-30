# gpuman

`gpuman` is the middle layer between Workman's `@gpu` shaders and raw WebGPU. It removes the
adapter, device, shader-module, pipeline, uniform-buffer, bind-group, command-encoder, render-pass,
submission, and mapped-readback chores without trying to become an engine or hide your frame loop.

New to Workman shaders or coming from Shadertoy/GLSL? Start with
[Shader programming in Workman](docs/shader-programming.md).

The shortest useful shape is:

```wm
from "./lib/gpuman.wm" import * as GpuMan;

let shade = (_coord) => {
  @gpu;
  (1.0, 0.2, 0.0, 1.0)
};

let fragment = Gpu.fragment(shade);

-- Given a GPUCanvasContext supplied by your browser/window toolkit:
-- GpuMan.requestDevice()
--   :> Task.andThen((device) => {
--     GpuMan.createRenderer(device, context, format, fragment) :> Task.fromResult
--   })
--   :> Task.map((renderer) => { GpuMan.draw(renderer, fragment) });
```

The shader stays ordinary Workman. For changing uniforms, create another value from the same
shader factory and pass it to `GpuMan.draw`; gpuman verifies artifact identity and uploads the new
uniform bytes. Resource-bearing fragments use the same path.

## Uniforms

Uniform schemas are user-defined nominal records, so field names and the number/order of fields are
application-specific. They are not arbitrary Workman values, however. The current GPU boundary
accepts these record fields:

- `Number`, inferred by shader use as `f32` or signed `i32`;
- homogeneous numeric tuples of width 2, 3, or 4;
- `Bool`, packed into a host-shareable 32-bit uniform slot;
- `Gpu.SampledTexture2D` and `Gpu.Sampler` resource fields.

Use `Gpu.f32` or `Gpu.i32` when inference needs an explicit numeric conversion. Nested records,
arrays/lists, strings, ADTs, functions, generic record parameters, and unused numeric
fields are not valid uniform fields in the current compiler slice.

Concrete nominal environment records retain their identity across imports. gpuman provides common
schemas in `lib/uniforms.wm`, or an application can define its own:

```wm
record Uniforms = {
  resolution: (Number, Number),
  time: Number,
  tint: (Number, Number, Number, Number)
};

let shade = (uniforms: Uniforms) => {
  (coord) => {
    @gpu;
    let uv = coord / uniforms.resolution;
    (uv.x * uniforms.tint.x, uv.y, sin(uniforms.time), 1.0)
  }
};
```

Each call to `Gpu.fragment(shade(nextUniforms))` keeps the same shader/pipeline identity while
carrying newly packed immutable uniform bytes.

## Modules

| Module | Owns |
| --- | --- |
| `lib/gpuman.wm` | Single-import facade for device, rendering, readback, and SDL windows. |
| `lib/device.wm` | WebGPU adapter/device discovery and preferred canvas format. |
| `lib/pipeline.wm` | Shader module, render pipeline, uniforms, resource bind groups. |
| `lib/render.wm` | Drawing a fullscreen fragment to any caller-owned `GPUCanvasContext`. |
| `lib/readback.wm` | Headless `rgba8unorm` rendering and mapped GPU pixel reads. |
| `lib/uniforms.wm` | Reusable concrete `Time`, `ResolutionTime`, and Bool-bearing `Frame` schemas. |
| `lib/sdl.wm` | Optional SDL2 + Deno `UnsafeWindowSurface` window adapter. |
| `lib/sdl_window.wm` | State-driven SDL lifecycle, event loop, resize, drawing, pacing, and cleanup. |

`render.wm` is deliberately the bring-your-own-window boundary. A browser canvas, SDL, or another
native toolkit only needs to provide a configured WebGPU canvas context; presentation and event
handling remain with that toolkit. No SDL type leaks into the renderer.

## Examples

```sh
wm check examples/window.wm
wm check examples/shader_showcase.wm
wm check examples/readback.wm
wm run examples/window.wm
wm run examples/shader_showcase.wm
wm run examples/readback.wm
```

[`examples/window.wm`](examples/window.wm) is an animated SDL window. It expects an SDL2 shared
library; set `settings.libraryPath` to `SDL2.dll` on Windows or, commonly,
`libSDL2-2.0.so.0` on Linux. The SDL adapter supports the Win32, X11, and Wayland native handles
exposed by SDL2 and Deno. It currently targets 64-bit Deno runtimes.

On Windows, the adapter selects D3D12 before Deno creates its WebGPU instance. This avoids a
Vulkan swapchain teardown panic in the wgpu version shipped by Deno 2.9.6. An explicitly supplied
`DENO_WEBGPU_BACKEND` environment variable is always respected.

[`examples/shader_showcase.wm`](examples/shader_showcase.wm) is the more substantial shader-language
tour: an animated procedural ray marcher using inferred scalar/vector specialization, a statically
eliminated higher-order call, an ADT result, integer tail-recursive stepping, domain warping, normal
estimation, palette math, and mouse-controlled camera uniforms.

For the usual case, import only `gpuman.wm` and use `GpuMan.runWindow` or
`GpuMan.runWindowAndReport`. A `GpuMan.WindowApp<State>` supplies only:

- initial immutable state;
- an event update function;
- a once-per-frame function returning `Continue(nextState)` or `Exit`;
- a state-to-`Gpu.Fragment` function.

The lower-level `sdl.wm` operations remain public for applications with unusual polling, timing,
or multi-window requirements.

[`examples/readback.wm`](examples/readback.wm) renders without a window. `GpuMan.Pixels` retains
WebGPU's padded row layout, so `GpuMan.pixelRowBytes` can exceed `width * 4`;
`GpuMan.pixelByte` accounts for that.

## Lifecycle

Create one renderer for one shader artifact, draw any number of updated instances from that same
artifact, then call `GpuMan.destroyRenderer`. The owner of a bring-your-own window/context remains
responsible for presenting it. `GpuMan.runWindow` owns presentation and cleanup for SDL windows.

## Workman implementation notes

See [`WORKMAN_PAPERCUTS.md`](WORKMAN_PAPERCUTS.md) for reduced reproductions and proposed fixes for
the compiler, GPU-boundary, module-facade, diagnostics, and `wm run` cleanup issues encountered while
building this library.
