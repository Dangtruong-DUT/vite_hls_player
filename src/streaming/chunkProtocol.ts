// Binary chunk wire format for browser (Uint8Array/DataView)
// Types
export const FRAME_CHUNK = 0x01; // [1:type][1:idLen][id][2:index][2:total][payload]
export const FRAME_DONE = 0x02; // [1:type][1:idLen][id]
export const FRAME_REQUEST = 0x03; // [1:type][1:idLen][id]

export const DEFAULT_CHUNK_SIZE = 32 * 1024; // 32KB

function textToUtf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function buildChunkFrame(segmentId: string, index: number, total: number, payload: ArrayBuffer | Uint8Array): Uint8Array {
  const idBytes = textToUtf8Bytes(segmentId);
  if (idBytes.length > 255) throw new Error('segmentId too long');
  const header = new Uint8Array(1 + 1 + idBytes.length + 2 + 2);
  let o = 0;
  header[o++] = FRAME_CHUNK;
  header[o++] = idBytes.length & 0xff;
  header.set(idBytes, o); o += idBytes.length;
  const view = new DataView(header.buffer);
  view.setUint16(o, index, false); o += 2;
  view.setUint16(o, total, false); o += 2;
  const payloadBytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  return concat(header, payloadBytes);
}

export function buildDoneFrame(segmentId: string): Uint8Array {
  const idBytes = textToUtf8Bytes(segmentId);
  if (idBytes.length > 255) throw new Error('segmentId too long');
  const buf = new Uint8Array(1 + 1 + idBytes.length);
  let o = 0;
  buf[o++] = FRAME_DONE;
  buf[o++] = idBytes.length & 0xff;
  buf.set(idBytes, o);
  return buf;
}

export function buildRequestFrame(segmentId: string): Uint8Array {
  const idBytes = textToUtf8Bytes(segmentId);
  if (idBytes.length > 255) throw new Error('segmentId too long');
  const buf = new Uint8Array(1 + 1 + idBytes.length);
  let o = 0;
  buf[o++] = FRAME_REQUEST;
  buf[o++] = idBytes.length & 0xff;
  buf.set(idBytes, o);
  return buf;
}

export type ParsedFrame =
  | { type: typeof FRAME_CHUNK; segmentId: string; index: number; total: number; payload: Uint8Array }
  | { type: typeof FRAME_DONE; segmentId: string }
  | { type: typeof FRAME_REQUEST; segmentId: string };

export function parseFrame(bufferLike: ArrayBuffer | Uint8Array): ParsedFrame {
  const b = bufferLike instanceof Uint8Array ? bufferLike : new Uint8Array(bufferLike);
  let o = 0;
  const type = b[o++];
  const idLen = b[o++];
  const idBytes = b.subarray(o, o + idLen); o += idLen;
  const segmentId = new TextDecoder().decode(idBytes);
  if (type === FRAME_CHUNK) {
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const index = view.getUint16(o, false); o += 2;
    const total = view.getUint16(o, false); o += 2;
    const payload = b.subarray(o);
    return { type, segmentId, index, total, payload } as ParsedFrame;
  }
  return { type, segmentId } as ParsedFrame;
}
