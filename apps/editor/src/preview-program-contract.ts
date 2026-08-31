/** The main-owned Preview Program Descriptor revision consumed by this Editor
 * release. A changed main descriptor is a compatibility event and requires an
 * explicit pin update after cross-repository review. */
export const previewProgramDescriptorIdentity =
    "3bcb22e27e7c2edeaf67dcb25d531cc89dbc443a8b5f19efe4d6885f32a5f8ad";

export function createPreviewSessionId(
    fill: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = (bytes) =>
        globalThis.crypto.getRandomValues(bytes),
): string {
    const bytes = fill(new Uint8Array(16));
    if (bytes.byteLength !== 16) {
        throw new Error("the Preview SessionId entropy source must return exactly 16 bytes");
    }
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
