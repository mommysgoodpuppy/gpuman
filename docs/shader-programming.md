# Shader programming in Workman

Workman lets a fragment shader be an ordinary typed function inside a Workman program. The shader
is not a GLSL string and there is no separate shader source file. Mark the GPU part of a function
with `@gpu`, turn it into a `Gpu.Fragment`, and let gpuman compile and draw it through WebGPU.

The style is inspired heavily by [GLML](https://www.glml-lang.com/index.html): shader expressions
are immutable, functions compose naturally, and host and shader code share one ML-like language.
Workman's implementation emits Slang and then WGSL, however, so its builtin spelling and current
feature set are not identical to GLML or GLSL.

This guide describes the implementation currently in this repository and Workman, not the larger
wmslang roadmap. Although the boundary is narrower than full GLSL, it is already capable of
substantial procedural shaders, ray marching, feedback cellular systems, and multi-field simulations.

## The smallest shader

```wm
from "./lib/gpuman.wm" import * as GpuMan;

let shade = (_coord) => {
  @gpu;
  (1.0, 0.2, 0.0, 1.0)
};

let fragment = Gpu.fragment(shade);
```

`shade` has the effective fragment shape:

```text
(f32, f32) -> (f32, f32, f32, f32)
```

The input is the pixel coordinate. The output is RGBA. gpuman supplies a fullscreen triangle and
the fragment entry point, so there is no vertex shader to write for this path.

The public Workman type still displays numeric values as `Number`. Inside a GPU island, the shader
compiler refines each occurrence to a concrete GPU representation such as `f32`, `i32`, or a vector.

## How much Workman syntax works inside `@gpu`?

`@gpu` does not switch to a separate grammar. The file is parsed, bound, and Hindley–Milner typed as
normal Workman first. Starting at a selected `Gpu.fragment(...)`, wmslang then closes over reachable
local functions and lowers only the expressions and types in its current shader algebra.

That means there are three useful categories:

1. ordinary Workman syntax that also lowers to shader code;
2. declarations used by the host-to-shader boundary but not represented as shader operations;
3. valid host Workman syntax that the shader lowerer currently rejects.

### Current syntax matrix

| Workman feature | Inside the selected shader island | Notes |
| --- | --- | --- |
| Numeric and boolean literals | Yes | Integral literals are `i32`; decimal literals are `f32`. |
| Tuple expressions | Yes, restricted | Homogeneous numeric tuples of width 2–4 become vectors. Private tuple products are supported only where their lowered contents are representable. |
| Tuple destructuring | Yes | Supported for function parameters and local immutable bindings. |
| `let` bindings | Yes | One non-recursive immutable binding per declaration; the block's final expression is its value. |
| Local functions | Yes | Declare them inside the selected GPU root and call them directly. Reachable calls are specialized. |
| Higher-order calls | Restricted | A function argument must be a statically known GPU-local helper and must disappear during specialization. No runtime closure remains. |
| `if` expressions | Yes | Both branches must produce the same concrete shader representation. |
| `match` expressions | Restricted | Currently for one local non-generic ADT, with every constructor covered exactly once. |
| Variant `type` declaration | Restricted | One reachable ADT beside the selected root; constructors are nullary or carry one `Number`. |
| Type aliases | Erased/checking only | Useful when they expand to supported Workman shapes, but aliases and annotations do not create new GPU representations or select overloads. |
| `record` declaration | Boundary only | One non-generic nominal record may describe uniforms and sampled resources for a curried shader factory. |
| Record literals, spread, and updates | Host only | Build/update the environment outside `@gpu`; local shader record values do not lower. |
| Record field access | Boundary only | Shader code may read fields of its outer environment. General local record projection is not supported. |
| `.x`, `.y`, `.z`, `.w` | Yes | Single numeric-vector lane projection only; rebuild tuples for multi-lane swizzles. |
| Arithmetic/comparison/boolean operators | Yes, finite rows | `+ - * / %`, unary `-`, comparisons, equality, `&&`, `||`, and `!`, subject to exact supported representations. |
| Custom operators/fixity | No | Not implemented in ordinary wm-mini either; shader operators are compiler-owned rows. |
| Forward pipe `:>` | No | It remains a `Pipe` AST node and is outside the current GPU expression lowerer. Use direct calls or nested expressions. |
| Carrier pipelines (`Result`, `Task`, `Option`) | Host only | Carriers organize setup/rendering code. They are not GPU effects or shader control flow. |
| Lists and list patterns | No | No shader list representation or recursive data layout. |
| Strings, interpolation, `++` | No | Strings have no shader representation. |
| General records, JSON, and JS FFI | No | Foreign calls and host objects cannot enter the GPU island. |
| Recursion | Restricted | One direct self-call in tail position; no mutual, non-tail, or polymorphic recursion. |
| `Panic` | No | A shader must produce a value through supported control flow. |
| Imports | Boundary/reuse only | Host APIs and nominal environment record types may be imported. Shader helpers must be lexically inside the selected root, and the reachable ADT must be declared in that root's module. |

“Type definition” needs a little care here. A declaration such as:

```wm
type Distance = Number;
```

is an ordinary Workman alias. If used in an annotation, it eventually erases to `Number`; it does
not introduce a distinct shader scalar. Likewise, this is a genuine variant declaration:

```wm
type MarchResult = Miss | Hit<Number>;
```

and can receive the current tagged shader representation. A generic `Option<T>`, recursive list,
imported variant, multiple reachable variants, or constructor with two payloads is beyond the
implemented ADT slice even though all are valid host Workman.

### Expression-oriented Workman still applies

Shader code need not imitate statement-heavy GLSL. `if`, `match`, and blocks produce values; there
is no `return`, assignment, or output parameter. Prefer making a whole helper an expression:

```wm
let background = (direction) => {
  let horizon = smoothstep(-0.7, 0.8, direction.y);
  (0.025, 0.035, 0.075) * (1.0 - horizon)
    + (0.18, 0.30, 0.48) * horizon
};

let chooseTone = (lit, vivid) => {
  if (vivid) {
    saturate(lit)
  } else {
    let luminance = dot(lit, (0.299, 0.587, 0.114));
    (luminance, luminance, luminance)
  }
};
```

The `let` declarations name shared intermediate values; the branch and function bodies remain
expressions. Compact direct composition is also fine:

```wm
let glow = pow(saturate(dot(normal, light)), 3.0);
let color = palette(distance * 0.2 + time) * (0.15 + glow * 0.85);
```

What does *not* currently transfer from expression-heavy host Workman is the pipe operator:

```wm
-- Host Workman style, but not currently a shader expression:
-- value :> transform :> saturate

-- Shader form:
saturate(transform(value))
```

Similarly, a first-class `match` function used in a pipeline is host syntax. In shader code, use a
direct local helper whose body is the supported ADT `match`.

## The Shadertoy mental-model translation

The closest equivalent to Shadertoy's `mainImage` is the function containing `@gpu`:

| Shadertoy / GLSL | Workman and gpuman |
| --- | --- |
| `fragCoord` | the shader function's `coord` argument |
| `fragColor` / return color | return a four-number tuple |
| `iResolution` | a field in a nominal uniform record |
| `iTime` | a field in a nominal uniform record |
| `iMouse` | application state copied into a uniform field |
| `iChannel0` | `Gpu.SampledTexture2D` plus `Gpu.Sampler` |
| `vec2(x, y)` | `(x, y)` |
| `vec3(x, y, z)` | `(x, y, z)` |
| `vec4(r, g, b, a)` | `(r, g, b, a)` |
| `v.x`, `v.y`, ... | `v.x`, `v.y`, ... |
| `fract(x)` | `frac(x)` |
| `mix(a, b, t)` | `lerp(a, b, t)` |
| `mod(x, y)` | `fmod(x, y)`, after checking negative-input semantics |
| `dFdx`, `dFdy` | `ddx`, `ddy` |

The spelling difference matters. Shader builtins use the canonical names from Workman's pinned
Slang toolchain. Workman does not provide a general GLSL compatibility namespace.
GLSL `mod` and Slang `fmod` differ for some negative inputs, so ports that rely on wrapping negative
coordinates should spell out and test the intended formula.

## Uniforms: resolution, time, and application state

Declare a nominal record and curry the shader over it:

```wm
record Uniforms = {
  resolution: (Number, Number),
  time: Number,
  enabled: Bool
};

let shade = (uniforms: Uniforms) => {
  (coord) => {
    @gpu;

    let uv = (coord - uniforms.resolution * 0.5) / uniforms.resolution.y;
    let pulse = 0.5 + 0.5 * sin(uniforms.time);

    if (uniforms.enabled) {
      (uv.x * 0.5 + 0.5, uv.y * 0.5 + 0.5, pulse, 1.0)
    } else {
      (0.0, 0.0, 0.0, 1.0)
    }
  }
};

let uniforms: Uniforms = .{
  resolution = (800.0, 600.0),
  time = 0.0,
  enabled = true
};

let fragment = Gpu.fragment(shade(uniforms));
```

The outer function is the shader factory. Its record is the host-to-GPU boundary. gpuman packs the
record into a uniform buffer, while the inner function becomes the fragment shader.

Supported uniform fields are currently:

- `Number`, when shader use determines it to be `f32` or signed `i32`;
- homogeneous numeric tuples with 2, 3, or 4 lanes;
- `Bool`, stored in a host-shareable 32-bit slot;
- `Gpu.SampledTexture2D` and `Gpu.Sampler` resource fields.

Unused numeric fields are rejected because the compiler has no evidence for whether they should be
`f32` or `i32`. Nested records, lists, strings, arbitrary ADTs, functions, and general arrays are not
uniform layouts.

Create a new immutable record for each frame and make a new fragment value from the same factory.
gpuman keeps the shader/pipeline identity and uploads only the changed uniform data.

## Coordinates are not Shadertoy-normalized

`coord` is in pixel coordinates. A common centered, aspect-correct coordinate is:

```wm
let uv = (coord * 2.0 - uniforms.resolution)
  / min(uniforms.resolution.x, uniforms.resolution.y);
```

This makes the shorter viewport dimension approximately span `-1.0` to `1.0`. Workman uses the
WebGPU surface convention supplied by the generated fullscreen backend. If a port is vertically
flipped relative to its source, make that transform explicitly in `uv` rather than assuming GLSL's
window convention.

## Vectors and arithmetic

Homogeneous numeric tuples of width 2–4 become vectors in GPU code:

```wm
let p = (0.25, 0.5);             -- f32x2
let color = (1.0, 0.4, 0.2);    -- f32x3
let shifted = p + 0.1;           -- scalar/vector broadcast
let tinted = color * 0.75;
```

The usual arithmetic operators are available for supported equal representations. Scalar/vector
broadcast is supported by the defined operator rows. Vector widths must otherwise agree.

There is no GLSL constructor overloading. Write tuples directly and build a new tuple to rearrange
lanes:

```wm
let swapped = (p.y, p.x);
let rgba = (color.x, color.y, color.z, 1.0);
```

Single-lane projection (`.x`, `.y`, `.z`, `.w`) is supported. Do not assume arbitrary GLSL swizzles
such as `.xy`, `.rgb`, repeated lanes, or swizzle assignment are available; construct the desired
tuple explicitly.

## Numbers are strict inside shaders

Workman has one public host type named `Number`, but shader literals carry concrete evidence:

- `1.0` is `f32`;
- `1` is signed `i32`;
- vectors inherit the representation of their lanes.

There is no implicit integer-to-float promotion:

```wm
-- Rejected: mixed i32 and f32.
-- let bad = 1 + 1.0;

let good = Gpu.f32(1) + 1.0;
let frame = Gpu.i32(uniforms.time);
```

The explicit conversions are `Gpu.f32` and `Gpu.i32`. There is currently no `u32`, `f16`, `f64`,
implicit widening, or general conversion lattice.

## Builtin math

Call shader builtins directly inside the GPU island without an import. Commonly useful operations
include:

```text
abs acos asin atan atan2 ceil clamp cos cross degrees distance dot
exp exp2 floor fma fmod frac fwidth length lerp log log2 max min
normalize pow radians reflect refract round rsqrt saturate sign sin
smoothstep sqrt step tan trunc ddx ddy
```

Availability depends on an exact overload representable by the current scalar/vector types and the
fragment/WGSL target. A name appearing in Slang does not imply that every Slang overload is usable.
Effectful, pointer-taking, matrix, subgroup, ray-tracing, mesh, atomic, and unsupported numeric
overloads are filtered out.

Builtins are contextual and direct-call-only:

```wm
let wave = sin(uniforms.time);  -- valid inside @gpu code
```

They cannot currently be imported, stored, returned, partially applied, or passed around as values.
A lexical Workman binding with the same name shadows the builtin.

Use editor completion or hover inside `@gpu` code for the authoritative overloads supported by the
installed Workman version.

## Functions, branches, and loops

Local immutable helpers are the natural way to structure a shader:

```wm
let shade = (uniforms: Uniforms) => {
  (coord) => {
    @gpu;

    let circle = (p, radius) => { length(p) - radius };
    let uv = (coord * 2.0 - uniforms.resolution) / uniforms.resolution.y;
    let distance = circle(uv, 0.5);
    let edge = smoothstep(0.01, -0.01, distance);
    (edge, edge, edge, 1.0)
  }
};
```

Helpers may be inferred and specialized for concrete scalar/vector uses. A deliberately bounded
higher-order subset also works when specialization can eliminate the function value before shader
emission. Runtime closures and general shader function values are not supported.

`if` and supported exhaustive `match` expressions return values. Shader code remains immutable: use
successive `let` bindings instead of variable assignment.

Direct self-tail recursion is the current loop construct. For example, a ray marcher can return an
ADT and match on it:

```wm
type MarchResult = Miss | Hit<Number>;

let rec march = (origin, direction, distance, steps) => {
  if (steps > 80 || distance > 100.0) {
    Miss
  } else {
    let stepDistance = sceneDistance(origin + direction * distance);
    if (stepDistance < 0.001) {
      Hit(distance)
    } else {
      march(origin, direction, distance + stepDistance, steps + 1)
    }
  }
};
```

The compiler lowers a direct tail call to a GPU loop. Non-tail recursion, mutual recursion, and
polymorphic recursion are rejected. There is no hidden iteration budget: always provide a real exit
condition, because an unbounded GPU loop can trigger the operating system's GPU watchdog.

### ADTs and pattern matching

One local, non-generic variant type may be reachable from a selected shader today. Its constructors
may be nullary or carry one `Number`, and a shader `match` must cover every constructor exactly once.
That narrow slice is still useful for explicit results such as `Miss | Hit<Number>`: it avoids
sentinel distances and keeps ray-march control flow typed until lowering.

The current implementation does not yet support multiple reachable shader ADTs, generic variants,
multiple constructor payloads, non-numeric payloads, or imported ADT declarations.

## Textures

The compiler currently supports read-only sampled 2D float textures and samplers when they are
fields of the outer shader environment:

```wm
record ImageInputs = {
  resolution: (Number, Number),
  image: Gpu.SampledTexture2D,
  sampler: Gpu.Sampler
};

let imageShade = (inputs: ImageInputs) => {
  (coord) => {
    @gpu;
    let uv = coord / inputs.resolution;
    inputs.image.Sample(inputs.sampler, uv)
  }
};
```

The shader operations are the pinned Slang `Texture2D.Sample` operation and exact `Load` with an
`i32x3` `(x, y, mip)` coordinate. Textures have one mip in the current slice, and shader-side
dimension queries are not available. Pass resolution as a uniform when needed.

gpuman's present facade currently focuses on surface rendering and readback. Workman's lower-level
V5 runtime contains the broader offscreen/feedback resource machinery; not every part of that host
API is wrapped by this library yet.

## A direct GLSL porting example

GLSL/Shadertoy:

```glsl
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (2.0 * fragCoord - iResolution.xy) / iResolution.y;
    float d = length(uv) - 0.45;
    float glow = 0.02 / abs(d);
    vec3 color = vec3(0.2, 0.5, 1.0) * glow;
    fragColor = vec4(color, 1.0);
}
```

Workman:

```wm
record Inputs = {
  resolution: (Number, Number)
};

let shade = (inputs: Inputs) => {
  (coord) => {
    @gpu;
    let uv = (coord * 2.0 - inputs.resolution) / inputs.resolution.y;
    let distance = length(uv) - 0.45;
    let glow = 0.02 / abs(distance);
    let color = (0.2, 0.5, 1.0) * glow;
    (color.x, color.y, color.z, 1.0)
  }
};
```

The important shift is not syntax. GLSL describes a mutable procedure that writes an output;
Workman describes an immutable expression whose value is the output color.

## How advanced can it get?

The narrow runtime model does not imply toy shader bodies. Workman's checked-in examples include:

- warped procedural noise with nested inferred helpers and scalar/vector specialization;
- an animated SDF ray marcher using an ADT result and tail-recursive stepping;
- multi-pass texture-feedback cellular systems with exact integer texel loads;
- reaction-like and catalytic continuous simulations;
- simulations where feedback textures hold evolving instruction or graph data;
- multiple offscreen fields, nearest and linear sampling, explicit ping-pong state, and a separate
  presentation fragment.

Those programs are under `C:/GIT/workman/examples/wmslang_*`. They exercise the Workman GPU runtime
directly; gpuman currently wraps the common single-pass surface and readback path.

This repository's [`examples/shader_showcase.wm`](../examples/shader_showcase.wm) is a compact
single-pass tour through the portion available via gpuman. It combines:

- one helper specialized at both scalar and vector shapes;
- a higher-order helper whose statically known function argument is erased during specialization;
- a local `Miss | Hit<Number>` ADT and exhaustive match;
- an `i32` tail-recursive ray-march counter with explicit `Gpu.f32` conversion;
- tuple vectors, scalar broadcast, projections, SDF composition, domain warping, normals, palette
  math, and numerous Slang builtins;
- animated, resize, mouse, and `Bool` uniform state.

Run it on Windows with:

```powershell
wm run .\examples\shader_showcase.wm
```

Move the mouse to orbit/pitch the camera. The example keeps every reusable shader helper inside the
selected `@gpu` island because that is the actual lexical boundary enforced by the current
normalizer.

## Current limitations

The practical shader boundary today is:

- fragment shaders returning one four-component color;
- gpuman's generated fullscreen vertex stage only;
- `f32`, signed `i32`, `Bool`, and homogeneous numeric vectors of width 2–4;
- immutable locals, expressions, branches, one local non-generic ADT with zero/one-number-payload
  constructors, and direct tail loops;
- GPU-local helpers and only statically eliminable higher-order uses;
- nominal uniform environments plus sampled 2D textures and samplers;
- direct eligible builtins from the pinned Slang catalog.

Not currently supported:

- authored vertex, compute, geometry, tessellation, mesh, or ray-tracing shaders;
- matrices and matrix uniforms;
- `u32`, `f16`, `f64`, implicit numeric conversion, or mixed `i32`/`f32` arithmetic;
- arbitrary arrays, lists, nested records, strings, multiple/generic ADTs, multi-field constructor
  payloads, or recursive data layouts in shader values;
- mutable variables, assignment, pointers, `ref`/`out`/`inout`, atomics, barriers, or shader writes;
- storage buffers, storage textures, general bind-group declarations, texture arrays, comparison
  samplers, anisotropy, arbitrary sampler descriptors, or general mip chains;
- arbitrary GLSL syntax, preprocessor directives, macros, raw GLSL/Slang/WGSL injection, or custom
  Slang module imports;
- general swizzles or swizzle assignment;
- first-class builtin functions, runtime closures, general defunctionalization, non-tail recursion,
  or mutual recursion;
- automatic Shadertoy channels, keyboard/audio inputs, multipass graphs, buffer swapping, or frame
  history supplied by gpuman.

Multipass and feedback rendering are possible in Workman's current GPU runtime, but the host owns
pass ordering, resource creation, ping-pong swapping, resize, and lifetime. There is no automatic
Shadertoy-style render graph.

## Debugging and workflow

Check the complete host program; the compiler discovers selected shader islands from
`Gpu.fragment`:

```sh
wm check examples/window.wm
wm run examples/window.wm
```

Useful rules when a GLSL port fails:

1. Add `.0` to literals that are intended to be floating point.
2. Replace GLSL names with Slang names such as `frac`, `lerp`, `ddx`, and `ddy`.
3. Replace compound assignment and mutation with new `let` bindings.
4. Construct vectors as tuples and rebuild multi-lane swizzles explicitly.
5. Ensure vector widths match and insert `Gpu.f32` or `Gpu.i32` at numeric boundaries.
6. Keep shader helpers within the selected GPU island unless the current Workman version explicitly
   supports the intended imported-helper shape.
7. Turn loops into direct tail recursion with an explicit exit condition.
8. Use hover inside the shader to see the selected concrete GPU type and builtin overload.

One current compiler papercut is worth knowing: a `let value = match(...)` initializer whose match
arms contain local declarations can fail during executable generation with a duplicate GPU block
item diagnostic. Extract that match into a local helper and make the `match` the helper's root
expression. [`examples/shader_showcase.wm`](../examples/shader_showcase.wm) demonstrates this shape
with `shadeMarch`.

For a small working example, start with [`examples/window.wm`](../examples/window.wm); for a broad
language tour, use [`examples/shader_showcase.wm`](../examples/shader_showcase.wm).
The Workman source tree also contains larger warped-noise, raymarching, feedback, and ocean examples
under `examples/wmslang_*`.

## Further reading

- [GLML](https://www.glml-lang.com/index.html), the main functional-shader influence.
- Workman's `markdown/wmslang/` design and implementation notes, especially the V3–V5 scope files.
- Workman's `examples/wmslang_window/` ports of warped noise and ray marching.
- [gpuman README](../README.md) for rendering, uniform packing, windowing, and readback APIs.
