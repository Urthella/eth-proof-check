// Ethereum's RLP: encoding for block headers, decoding for trie nodes.

export type Rlp = Uint8Array | Rlp[];

function length(prefix: number, n: number): Buffer {
  if (n < 56) return Buffer.of(prefix + n);
  const digits = n.toString(16);
  const bytes = Buffer.from(digits.length % 2 ? `0${digits}` : digits, "hex");
  return Buffer.concat([Buffer.of(prefix + 55 + bytes.length), bytes]);
}

export function encode(item: Rlp): Buffer {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0] < 0x80) return Buffer.from(item);
    return Buffer.concat([length(0x80, item.length), item]);
  }
  const body = Buffer.concat(item.map(encode));
  return Buffer.concat([length(0xc0, body.length), body]);
}

function readLength(b: Uint8Array, at: number, bytes: number): number {
  if (at + bytes > b.length) throw new Error("RLP ends inside a length");
  let n = 0;
  for (let i = 0; i < bytes; i++) n = n * 256 + b[at + i];
  return n;
}

function decodeAt(b: Uint8Array, at: number): [Rlp, number] {
  const prefix = b[at];
  if (prefix === undefined) throw new Error("RLP ends early");
  let start: number;
  let size: number;
  if (prefix < 0x80) return [b.subarray(at, at + 1), at + 1];
  if (prefix < 0xb8) [start, size] = [at + 1, prefix - 0x80];
  else if (prefix < 0xc0) [start, size] = [at + 1 + (prefix - 0xb7), readLength(b, at + 1, prefix - 0xb7)];
  else if (prefix < 0xf8) [start, size] = [at + 1, prefix - 0xc0];
  else [start, size] = [at + 1 + (prefix - 0xf7), readLength(b, at + 1, prefix - 0xf7)];
  const end = start + size;
  if (end > b.length) throw new Error("RLP ends early");
  if (prefix < 0xc0) return [b.subarray(start, end), end];
  const items: Rlp[] = [];
  for (let pos = start; pos < end; ) {
    const [item, next] = decodeAt(b, pos);
    items.push(item);
    pos = next;
  }
  return [items, end];
}

export function decode(b: Uint8Array): Rlp {
  const [item, end] = decodeAt(b, 0);
  if (end !== b.length) throw new Error(`${b.length - end} bytes after the RLP item`);
  return item;
}

/** A hex quantity as minimal big-endian bytes: zero is the empty string. */
export function quantity(hex: string): Buffer {
  const n = BigInt(hex);
  if (n === 0n) return Buffer.alloc(0);
  const digits = n.toString(16);
  return Buffer.from(digits.length % 2 ? `0${digits}` : digits, "hex");
}

/** Hex data as bytes, kept at its length. */
export const data = (hex: string) => Buffer.from(hex.slice(2), "hex");
