import assert from "node:assert/strict";
import { test } from "node:test";

import { type Rlp, decode, encode, quantity } from "../src/rlp.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const str = (s: string) => Buffer.from(s);

test("RLP encodes the examples in Ethereum's specification", () => {
  assert.equal(hex(encode(str("dog"))), "83646f67");
  assert.equal(hex(encode([str("cat"), str("dog")])), "c88363617483646f67");
  assert.equal(hex(encode(str(""))), "80");
  assert.equal(hex(encode([])), "c0");
  assert.equal(hex(encode(quantity("0x0"))), "80", "zero is the empty string");
  assert.equal(hex(encode(quantity("0x400"))), "820400");
  const lorem = "Lorem ipsum dolor sit amet, consectetur adipisicing elit";
  assert.equal(hex(encode(str(lorem))), `b838${hex(str(lorem))}`);
});

test("RLP decodes what it encodes, long lists included", () => {
  const nested = [str("cat"), [str(""), [str("dog")]], str("x".repeat(60)), Array.from({ length: 20 }, (_, i) => str(`item ${i}`))];
  const strings = (x: Rlp): unknown => (x instanceof Uint8Array ? Buffer.from(x).toString() : x.map(strings));
  assert.deepEqual(strings(decode(encode(nested))), strings(nested));
  assert.equal(hex(decode(Buffer.from("0f", "hex")) as Uint8Array), "0f", "a byte under 0x80 is itself");
});

test("RLP that ends early, or has bytes after it, doesn't decode", () => {
  assert.throws(() => decode(Buffer.from("83646f", "hex")), /RLP ends early/);
  assert.throws(() => decode(Buffer.from("c88363617483646f", "hex")), /RLP ends early/);
  assert.throws(() => decode(Buffer.from("b9", "hex")), /RLP ends inside a length/);
  assert.throws(() => decode(Buffer.from("83646f6700", "hex")), /1 bytes after the RLP item/);
});
