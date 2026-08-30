/// <reference lib="deno.unstable" />

export interface SdlEvent {
  readonly kind: number;
  readonly a: number;
  readonly b: number;
}

export interface SdlWindow {
  readonly surface: Deno.UnsafeWindowSurface;
  readonly library: Deno.DynamicLibrary<SdlSymbols>;
  readonly window: Deno.PointerValue;
  readonly eventBytes: Uint8Array;
  readonly eventPointer: Deno.PointerObject;
  readonly eventView: Deno.UnsafePointerView;
  closed: boolean;
}

type SdlSymbols = {
  SDL_Init: { parameters: readonly ["u32"]; result: "i32" };
  SDL_Quit: { parameters: readonly []; result: "void" };
  SDL_CreateWindow: {
    parameters: readonly ["buffer", "i32", "i32", "i32", "i32", "u32"];
    result: "pointer";
  };
  SDL_DestroyWindow: { parameters: readonly ["pointer"]; result: "void" };
  SDL_GetWindowWMInfo: {
    parameters: readonly ["pointer", "pointer"];
    result: "i32";
  };
  SDL_GetVersion: { parameters: readonly ["pointer"]; result: "void" };
  SDL_PollEvent: { parameters: readonly ["pointer"]; result: "i32" };
  SDL_Delay: { parameters: readonly ["u32"]; result: "void" };
};

const symbols = {
  SDL_Init: { parameters: ["u32"], result: "i32" },
  SDL_Quit: { parameters: [], result: "void" },
  SDL_CreateWindow: {
    parameters: ["buffer", "i32", "i32", "i32", "i32", "u32"],
    result: "pointer",
  },
  SDL_DestroyWindow: { parameters: ["pointer"], result: "void" },
  SDL_GetWindowWMInfo: { parameters: ["pointer", "pointer"], result: "i32" },
  SDL_GetVersion: { parameters: ["pointer"], result: "void" },
  SDL_PollEvent: { parameters: ["pointer"], result: "i32" },
  SDL_Delay: { parameters: ["u32"], result: "void" },
} as const;

const SDL_INIT_VIDEO = 0x20;
const SDL_WINDOW_SHOWN = 0x04;
const SDL_WINDOW_RESIZABLE = 0x20;
const SDL_WINDOWPOS_CENTERED = 0x2fff0000;
const SDL_QUIT = 0x100;
const SDL_WINDOWEVENT = 0x200;
const SDL_WINDOWEVENT_SIZE_CHANGED = 6;
const SDL_MOUSEMOTION = 0x400;

// SDL_SYSWM_TYPE values from SDL2's SDL_syswm.h.
const SDL_SYSWM_WINDOWS = 1;
const SDL_SYSWM_X11 = 2;
const SDL_SYSWM_WAYLAND = 6;

type NativeWindow = {
  readonly system: "win32" | "x11" | "wayland";
  readonly windowHandle: Deno.PointerObject;
  readonly displayHandle: Deno.PointerValue;
};

function nativeWindow(view: Deno.UnsafePointerView): NativeWindow {
  const subsystem = view.getUint32(4);

  // The SDL_SysWMinfo union starts at byte 8 on the 64-bit platforms supported
  // by Deno. Win32 stores HWND, HDC, HINSTANCE; X11/Wayland store display first
  // and window/surface second.
  if (subsystem === SDL_SYSWM_WINDOWS) {
    const windowHandle = view.getPointer(8);
    const displayHandle = view.getPointer(24);
    if (!windowHandle) throw new Error("SDL returned no Win32 HWND");
    return { system: "win32", windowHandle, displayHandle };
  }

  if (subsystem === SDL_SYSWM_X11 || subsystem === SDL_SYSWM_WAYLAND) {
    const displayHandle = view.getPointer(8);
    const windowHandle = view.getPointer(16);
    if (!displayHandle || !windowHandle) {
      throw new Error("SDL returned incomplete native handles");
    }
    return {
      system: subsystem === SDL_SYSWM_X11 ? "x11" : "wayland",
      windowHandle,
      displayHandle,
    };
  }

  throw new Error(`unsupported SDL window subsystem ${subsystem}`);
}

function selectWindowsWebGpuBackend(): void {
  if (Deno.build.os !== "windows") return;

  try {
    // Deno/wgpu currently prefers Vulkan on some Windows machines. wgpu 29's
    // Vulkan surface teardown can panic while releasing an acquired texture;
    // D3D12 is the native Windows backend and avoids that failure. Respect an
    // explicit caller choice, and set this before UnsafeWindowSurface creates
    // Deno's shared wgpu instance.
    if (Deno.env.get("DENO_WEBGPU_BACKEND") === undefined) {
      Deno.env.set("DENO_WEBGPU_BACKEND", "dx12");
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotCapable)) throw error;
  }
}

export function openWindow(
  libraryPath: string,
  title: string,
  width: number,
  height: number,
  resizable: boolean,
): SdlWindow {
  if (
    !Number.isInteger(width) || width <= 0 || !Number.isInteger(height) ||
    height <= 0
  ) {
    throw new Error("SDL window dimensions must be positive integers");
  }

  selectWindowsWebGpuBackend();

  const library = Deno.dlopen<SdlSymbols>(libraryPath, symbols);
  try {
    if (library.symbols.SDL_Init(SDL_INIT_VIDEO) !== 0) {
      throw new Error("SDL_Init failed");
    }
    const encoded = new TextEncoder().encode(`${title}\0`);
    const flags = SDL_WINDOW_SHOWN | (resizable ? SDL_WINDOW_RESIZABLE : 0);
    const window = library.symbols.SDL_CreateWindow(
      encoded,
      SDL_WINDOWPOS_CENTERED,
      SDL_WINDOWPOS_CENTERED,
      width,
      height,
      flags,
    );
    if (!window) throw new Error("SDL_CreateWindow failed");

    try {
      const info = new Uint8Array(519);
      const infoPointer = Deno.UnsafePointer.of(info);
      if (!infoPointer) throw new Error("could not address SDL_SysWMInfo");
      library.symbols.SDL_GetVersion(infoPointer);
      if (library.symbols.SDL_GetWindowWMInfo(window, infoPointer) !== 1) {
        throw new Error("SDL_GetWindowWMInfo failed");
      }
      const view = new Deno.UnsafePointerView(infoPointer);
      const { system, windowHandle, displayHandle } = nativeWindow(view);

      const surface = new Deno.UnsafeWindowSurface({
        system,
        windowHandle,
        displayHandle,
        width,
        height,
      });
      const eventBytes = new Uint8Array(56);
      const eventPointer = Deno.UnsafePointer.of(eventBytes);
      if (!eventPointer) throw new Error("could not address SDL_Event");
      return {
        surface,
        library,
        window,
        eventBytes,
        eventPointer,
        eventView: new Deno.UnsafePointerView(eventPointer),
        closed: false,
      };
    } catch (error) {
      library.symbols.SDL_DestroyWindow(window);
      throw error;
    }
  } catch (error) {
    library.symbols.SDL_Quit();
    library.close();
    throw error;
  }
}

// kind: 0 none/ignored, 1 quit, 2 resize(a=width,b=height),
// 3 mouse motion(a=dx,b=dy).
export function pollEvent(runtime: SdlWindow): SdlEvent {
  if (runtime.library.symbols.SDL_PollEvent(runtime.eventPointer) !== 1) {
    return { kind: 0, a: 0, b: 0 };
  }
  const type = runtime.eventView.getUint32(0);
  if (type === SDL_QUIT) return { kind: 1, a: 0, b: 0 };
  if (
    type === SDL_WINDOWEVENT &&
    runtime.eventView.getUint8(12) === SDL_WINDOWEVENT_SIZE_CHANGED
  ) {
    return {
      kind: 2,
      a: runtime.eventView.getInt32(16),
      b: runtime.eventView.getInt32(20),
    };
  }
  if (type === SDL_MOUSEMOTION) {
    return {
      kind: 3,
      a: runtime.eventView.getInt32(28),
      b: runtime.eventView.getInt32(32),
    };
  }
  return { kind: 0, a: 0, b: 0 };
}

export const eventKind = (event: SdlEvent): number => event.kind;
export const eventA = (event: SdlEvent): number => event.a;
export const eventB = (event: SdlEvent): number => event.b;

export function canvasContext(runtime: SdlWindow): GPUCanvasContext {
  const context = runtime.surface.getContext("webgpu");
  if (!context) {
    throw new Error("Deno UnsafeWindowSurface returned no WebGPU context");
  }
  return context as GPUCanvasContext;
}

export function resizeWindowSurface(
  runtime: SdlWindow,
  width: number,
  height: number,
): void {
  runtime.surface.width = width;
  runtime.surface.height = height;
}

export function presentWindow(runtime: SdlWindow): void {
  runtime.surface.present();
}

export function delay(runtime: SdlWindow, milliseconds: number): void {
  runtime.library.symbols.SDL_Delay(milliseconds);
}

export function closeWindow(runtime: SdlWindow): void {
  if (runtime.closed) return;
  runtime.closed = true;
  runtime.library.symbols.SDL_DestroyWindow(runtime.window);
  runtime.library.symbols.SDL_Quit();
  runtime.library.close();
}
