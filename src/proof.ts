// Checks what eth_getProof returns against a block: the header must hash to the block hash, and
// each value must sit at its key in the state trie, or the account's storage trie, under the
// root the header commits to.

import { keccak256 } from "./keccak.ts";
import { type Rlp, data, decode, encode, quantity } from "./rlp.ts";
import type { Header, Proof } from "./rpc.ts";

/** keccak256(rlp("")): the root of a trie with nothing in it. */
export const EMPTY_ROOT = "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421";

const nibbles = (b: Uint8Array) => [...b].flatMap((x) => [x >> 4, x & 15]);

/** A leaf's or extension's path: the first nibble says which, and whether a padding nibble follows. */
function hexPrefix(path: Uint8Array): { leaf: boolean; part: number[] } {
  const n = nibbles(path);
  if (n[0] > 3) throw new Error(`a path with flag ${n[0]}`);
  return { leaf: n[0] >= 2, part: n.slice(n[0] % 2 ? 1 : 2) };
}

/**
 * Walks a Merkle-Patricia proof from `root` along `key`'s nibbles. Every node must hash to the
 * reference its parent holds (nodes under 32 bytes sit inside their parent), and every node of the
 * proof must be used. Returns the value at the key, or undefined when the proof shows nothing is
 * there; throws when the proof doesn't hold.
 */
export function walk(root: string, key: Uint8Array, proof: string[]): Buffer | undefined {
  if (root === EMPTY_ROOT && !proof.length) return undefined;
  const path = nibbles(key);
  let ref: Rlp = data(root);
  let used = 0;
  let at = 0;
  const done = (value: Uint8Array | undefined) => {
    if (used !== proof.length) throw new Error(`${proof.length - used} proof nodes are left over`);
    return value && Buffer.from(value);
  };
  for (;;) {
    let node: Rlp = ref;
    if (ref instanceof Uint8Array) {
      if (ref.length !== 32) throw new Error(`a ${ref.length}-byte reference: neither a hash nor a node`);
      if (used === proof.length) throw new Error(`the proof ends after ${used} nodes`);
      const bytes = data(proof[used]);
      if (!keccak256(bytes).equals(ref)) throw new Error(`proof node ${used} doesn't hash to the reference before it`);
      used++;
      node = decode(bytes);
    }
    if (!Array.isArray(node)) throw new Error("a trie node that isn't a list");
    if (node.length === 17) {
      // Keys are all 32 bytes here, so a value never sits in a branch.
      if (at === path.length) throw new Error("the key ends at a branch");
      const child: Rlp = node[path[at++]];
      if (child instanceof Uint8Array && child.length === 0) return done(undefined);
      ref = child;
    } else if (node.length === 2) {
      const { leaf, part } = hexPrefix(node[0] as Uint8Array);
      const matches = part.every((x, i) => path[at + i] === x);
      if (leaf) return done(matches && at + part.length === path.length ? (node[1] as Uint8Array) : undefined);
      if (!matches) return done(undefined);
      at += part.length;
      ref = node[1];
    } else {
      throw new Error(`a trie node with ${node.length} items`);
    }
  }
}

/**
 * The header's fields in RLP order, each with how it's encoded. Later forks append fields, so a
 * header carries a prefix of the list: London's base fee, Shanghai's withdrawals root, Cancun's
 * blob gas and beacon root, Prague's requests hash.
 */
const FIELDS: [string, "data" | "quantity"][] = [
  ["parentHash", "data"], ["sha3Uncles", "data"], ["miner", "data"], ["stateRoot", "data"], ["transactionsRoot", "data"], ["receiptsRoot", "data"],
  ["logsBloom", "data"], ["difficulty", "quantity"], ["number", "quantity"], ["gasLimit", "quantity"], ["gasUsed", "quantity"], ["timestamp", "quantity"],
  ["extraData", "data"], ["mixHash", "data"], ["nonce", "data"], ["baseFeePerGas", "quantity"], ["withdrawalsRoot", "data"], ["blobGasUsed", "quantity"],
  ["excessBlobGas", "quantity"], ["parentBeaconBlockRoot", "data"], ["requestsHash", "data"],
];

export interface AccountResult {
  address: string;
  exists: boolean;
  /** What the proof holds; zero for a missing account. */
  nonce: string;
  balance: string;
  /** Bytes of code, when eth_getCode was given. */
  codeSize?: number;
  /** Nodes in the account's proof. */
  nodes: number;
  slots: { key: string; value: string; nodes: number }[];
  problems: string[];
}

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
const toBigInt = (b: Uint8Array) => (b.length ? BigInt(hex(b)) : 0n);
const slotKey = (key: string) => keccak256(Buffer.from(BigInt(key).toString(16).padStart(64, "0"), "hex"));

/**
 * Checks eth_getProof's answer for one account against `stateRoot`: the account, or its absence,
 * must be what the node claims, each slot's value must sit under the account's storage root, and
 * the code, when given, must hash to the account's code hash.
 */
export function checkAccount(stateRoot: string, proof: Proof, code?: string): AccountResult {
  const result: AccountResult = { address: proof.address, exists: false, nonce: "0", balance: "0", codeSize: code === undefined ? undefined : data(code).length, nodes: proof.accountProof.length, slots: [], problems: [] };
  const problem = (where: string, error: unknown) => result.problems.push(`${where}: ${(error as Error).message}`);
  let storageRoot = EMPTY_ROOT;
  let codeHash: string | undefined;
  try {
    const found = walk(stateRoot, keccak256(data(proof.address)), proof.accountProof);
    result.exists = !!found;
    if (found) {
      const [nonce, balance, storage, codeHashBytes] = decode(found) as Uint8Array[];
      [storageRoot, codeHash] = [hex(storage), hex(codeHashBytes)];
      [result.nonce, result.balance] = [String(toBigInt(nonce)), String(toBigInt(balance))];
      const claims: [string, bigint | string, bigint | string][] = [["nonce", BigInt(proof.nonce), toBigInt(nonce)], ["balance", BigInt(proof.balance), toBigInt(balance)], ["storage root", proof.storageHash, storageRoot], ["code hash", proof.codeHash, codeHash]];
      for (const [name, claimed, held] of claims) if (claimed !== held) result.problems.push(`the node claims ${name} ${claimed}, the proof holds ${held}`);
    } else {
      // Nodes disagree on how to show a missing account's hashes; its nonce and balance are zero.
      for (const [name, claimed] of [["nonce", proof.nonce], ["balance", proof.balance]]) if (BigInt(claimed)) result.problems.push(`no account at this address, but the node claims ${name} ${BigInt(claimed)}`);
    }
  } catch (error) {
    problem("account proof", error);
  }
  for (const slot of proof.storageProof) {
    try {
      const found = walk(storageRoot, slotKey(slot.key), slot.proof);
      const held = found ? toBigInt(decode(found) as Uint8Array) : 0n;
      if (held !== BigInt(slot.value)) result.problems.push(`slot ${slot.key}: the node claims ${BigInt(slot.value)}, the proof holds ${held}`);
      result.slots.push({ key: slot.key, value: String(held), nodes: slot.proof.length });
    } catch (error) {
      problem(`slot ${slot.key}`, error);
    }
  }
  if (code !== undefined && codeHash) {
    const hash = hex(keccak256(data(code)));
    if (hash !== codeHash) result.problems.push(`eth_getCode's ${data(code).length} bytes hash to ${hash}, not the account's code hash ${codeHash}`);
  }
  return result;
}

/** How many mapping indexes --erc20 tries: plain tokens declare their balances early. */
const MAPPING_INDEXES = 20;

export interface BalanceSlot {
  index: number;
  layout: "Solidity" | "Vyper";
  key: string;
}

/** Where a balance mapping at index i keeps `holder`: keccak(holder, i) in Solidity, keccak(i, holder) in Vyper. */
export function balanceSlots(holder: string): BalanceSlot[] {
  const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const key = (a: string, b: string) => hex(keccak256(Buffer.from(word(a) + word(b), "hex")));
  return Array.from({ length: MAPPING_INDEXES }, (_, i) => [
    { index: i, layout: "Solidity" as const, key: key(holder, i.toString(16)) },
    { index: i, layout: "Vyper" as const, key: key(i.toString(16), holder) },
  ]).flat();
}

/**
 * Finds the candidate slot whose proven value is `balance`, what balanceOf said. The value comes
 * from the proof; balanceOf only picks the slot. Returns why not, when none or every empty one could.
 */
export function locateBalance(candidates: BalanceSlot[], account: AccountResult, balance: bigint): (BalanceSlot & { value: bigint; nodes: number }) | string {
  if (balance === 0n) return "balanceOf says 0, which every empty slot holds too";
  for (const c of candidates) {
    const slot = account.slots.find((s) => BigInt(s.key) === BigInt(c.key));
    if (slot && BigInt(slot.value) === balance) return { ...c, value: BigInt(slot.value), nodes: slot.nodes };
  }
  return `no balance mapping at indexes 0 to ${MAPPING_INDEXES - 1} holds ${balance}, what balanceOf says`;
}

export function headerHash(header: Header): string {
  const items: Buffer[] = [];
  for (const [name, kind] of FIELDS) {
    if (header[name] === undefined) break;
    items.push(kind === "data" ? data(header[name]) : quantity(header[name]));
  }
  return `0x${keccak256(encode(items)).toString("hex")}`;
}
