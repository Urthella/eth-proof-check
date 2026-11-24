// Checks the saved mainnet proofs, then breaks them one node at a time.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { audit, exitCode } from "../src/audit.ts";
import { keccak256 } from "../src/keccak.ts";
import { checkAccount, headerHash, walk } from "../src/proof.ts";
import { decode, encode } from "../src/rlp.ts";
import type { Header, Proof } from "../src/rpc.ts";

const load = (): { header: Header; proofs: Proof[]; code: Record<string, string> } => JSON.parse(gunzipSync(readFileSync(new URL("fixtures/mainnet.json.gz", import.meta.url))).toString());

test("a real header rebuilds to its block hash", () => {
  const { header } = load();
  assert.equal(headerHash(header), header.hash);
});

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;

test("an account's proof leads from the state root to the account the node claims", () => {
  const { header, proofs } = load();
  const weth = proofs[0];
  const found = walk(header.stateRoot, keccak256(Buffer.from(weth.address.slice(2), "hex")), weth.accountProof);
  assert.ok(found, "WETH exists");
  const [nonce, balance, storageRoot, codeHash] = decode(found) as Uint8Array[];
  assert.equal(BigInt(hex(nonce)), BigInt(weth.nonce));
  assert.equal(BigInt(hex(balance)), BigInt(weth.balance));
  assert.equal(hex(storageRoot), weth.storageHash);
  assert.equal(hex(codeHash), weth.codeHash);
});

test("every saved account, slot and code checks out against the state root", () => {
  const { header, proofs, code } = load();
  for (const p of proofs) {
    const result = checkAccount(header.stateRoot, p, code[p.address]);
    assert.deepEqual(result.problems, [], p.address);
    assert.equal(result.slots.length, 2);
  }
  assert.deepEqual(proofs.map((p) => checkAccount(header.stateRoot, p, code[p.address]).exists), [true, true, false]);
});

const broken = (change: (p: Proof) => void, account = 0) => {
  const { header, proofs, code } = load();
  change(proofs[account]);
  return checkAccount(header.stateRoot, proofs[account], code[proofs[account].address]).problems.join("\n");
};

test("a claimed balance, nonce or storage value the proof doesn't hold fails", () => {
  assert.match(broken((p) => (p.balance = `0x${(BigInt(p.balance) + 1n).toString(16)}`)), /the node claims balance \d+, the proof holds \d+/);
  assert.match(broken((p) => (p.nonce = "0x2")), /the node claims nonce 2, the proof holds 1/);
  assert.match(broken((p) => (p.storageProof[1].value = "0x1")), /slot 0x99: the node claims 1, the proof holds 0/);
  assert.match(broken((p) => (p.balance = "0x1"), 2), /no account at this address, but the node claims balance 1/);
});

test("a proof node that doesn't hash to its parent's reference, or a node too many, fails", () => {
  assert.match(broken((p) => (p.accountProof[3] = p.accountProof[3].replace(/.$/, (c) => (c === "0" ? "1" : "0")))), /account proof: proof node 3 doesn't hash to the reference before it/);
  assert.match(broken((p) => p.accountProof.push(p.accountProof[0])), /account proof: 1 proof nodes are left over/);
  assert.match(broken((p) => p.storageProof[0].proof.pop()), /slot 0x0: the proof ends after \d+ nodes/);
});

test("code that doesn't hash to the account's code hash fails", () => {
  const { header, proofs } = load();
  assert.match(checkAccount(header.stateRoot, proofs[0], "0x6000").problems.join(), /eth_getCode's 2 bytes hash to 0x[0-9a-f]{64}, not the account's code hash/);
});

test("an unused address's proof shows no account there", () => {
  const { header, proofs } = load();
  const unused = proofs[2];
  assert.equal(walk(header.stateRoot, keccak256(Buffer.from(unused.address.slice(2), "hex")), unused.accountProof), undefined);
});

test("a storage proof leads from the account's storage root to the slot's value, or shows it empty", () => {
  const { proofs } = load();
  const weth = proofs[0];
  const [name, empty] = weth.storageProof;
  const slot = (key: string) => keccak256(Buffer.from(BigInt(key).toString(16).padStart(64, "0"), "hex"));
  const value = walk(weth.storageHash, slot(name.key), name.proof)!;
  assert.equal(Buffer.from(decode(value) as Uint8Array).toString("latin1").slice(0, 13), "Wrapped Ether", "WETH9 keeps its name in slot 0");
  assert.equal(walk(weth.storageHash, slot(empty.key), empty.proof), undefined);
});

test("a header that doesn't hash to its block hash exits 1 on its own", () => {
  const report = audit({ ...load(), slots: [] });
  assert.equal(exitCode(report), 0);
  report.rebuilt = `0x${"00".repeat(32)}`;
  assert.equal(exitCode(report), 1);
});

test("an extension node, which the saved mainnet paths don't cross, leads on to its branch", () => {
  // Two keys that differ only in their last nibble: the root is an extension over the 63 shared
  // nibbles, then a branch, then a leaf for each.
  const [k1, k2, off] = [Buffer.alloc(32), Buffer.alloc(32), Buffer.alloc(32)];
  k2[31] = 1;
  off[0] = 0x10;
  const leaf = (value: Buffer) => encode([Buffer.of(0x20), value]);
  const [l1, l2] = [leaf(Buffer.alloc(32, 0xaa)), leaf(Buffer.alloc(32, 0xbb))];
  const branch = encode([keccak256(l1), keccak256(l2), ...Array<Buffer>(15).fill(Buffer.alloc(0))]);
  // 63 nibbles is odd: the flag 1 shares a byte with the first, then 31 bytes of pairs.
  const extension = encode([Buffer.concat([Buffer.of(0x10), Buffer.alloc(31)]), keccak256(branch)]);
  const root = hex(keccak256(extension));
  assert.equal(walk(root, k1, [extension, branch, l1].map(hex))?.toString("hex"), "aa".repeat(32));
  assert.equal(walk(root, k2, [extension, branch, l2].map(hex))?.toString("hex"), "bb".repeat(32));
  assert.equal(walk(root, off, [hex(extension)]), undefined, "a key off the extension's path isn't there");
});
