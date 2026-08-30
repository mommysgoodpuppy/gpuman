// Copy before GPUBuffer.unmap(), which invalidates the mapped ArrayBuffer.
export function copyMappedBytes(range: ArrayBuffer): Uint8Array {
  return new Uint8Array(range).slice();
}

export const byteLength = (bytes: Uint8Array): number => bytes.byteLength;
export const byteAt = (bytes: Uint8Array, index: number): number => bytes.at(index) ?? 0;
