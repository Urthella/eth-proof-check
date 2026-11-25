// Proving a token balance from storage: the balance mapping's slot for the holder, found by the
// value balanceOf gives, and the value read from the proof, not from eth_call.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { keccak256 } from "../src/keccak.ts";
import { balanceSlots, checkAccount, locateBalance } from "../src/proof.ts";
import type { Header, Proof } from "../src/rpc.ts";

interface Saved {
  header: Header;
  tokens: { token: string; holder: string; proof: Proof; balance: string }[];
}
const load = (): Saved => JSON.parse(gunzipSync(readFileSync(new URL("fixtures/erc20.json.gz", import.meta.url))).toString());
const pad = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
const reason = (located: ReturnType<typeof locateBalance>) => ("reason" in located ? located.reason : "found");

test("a mapping at index i puts a holder at keccak(holder, i), or keccak(i, holder) in Vyper", () => {
  const holder = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
  const slots = balanceSlots(holder);
  assert.equal(slots.length, 40);
  const solidity3 = slots.find((s) => s.index === 3 && s.layout === "Solidity")!;
  assert.equal(solidity3.key, `0x${keccak256(Buffer.from(pad(holder) + pad("3"), "hex")).toString("hex")}`);
  const vyper3 = slots.find((s) => s.index === 3 && s.layout === "Vyper")!;
  assert.equal(vyper3.key, `0x${keccak256(Buffer.from(pad("3") + pad(holder), "hex")).toString("hex")}`);
  const solidity12 = slots.find((s) => s.index === 12 && s.layout === "Solidity")!;
  assert.equal(solidity12.key, `0x${keccak256(Buffer.from(pad(holder) + pad("c"), "hex")).toString("hex")}`, "index 12 is 0x0c");
});

test("real tokens' balances are found at their mapping, and the value is the proof's", () => {
  const { header, tokens } = load();
  const found = tokens.map(({ token, holder, proof, balance }) => {
    const account = checkAccount(header.stateRoot, proof, undefined, balanceSlots(holder).map((s) => s.key));
    assert.deepEqual(account.problems, [], token);
    const located = locateBalance(balanceSlots(holder), account, BigInt(balance));
    assert.ok("found" in located, `${token}: ${reason(located)}`);
    const slot = account.slots.find((s) => BigInt(s.key) === BigInt(located.found.key))!;
    assert.equal(located.found.value, slot.value, "the value comes from the proven slot");
    assert.equal(located.found.value, balance);
    return `${located.found.layout} ${located.found.index}`;
  });
  // WETH9 declares name, symbol and decimals before balanceOf, and so does CRV, in Vyper; USDC's
  // FiatToken keeps balances at 9.
  assert.deepEqual(found, ["Solidity 3", "Solidity 9", "Vyper 3"]);
});

test("no answer, a zero balance, a balance no slot holds, or two that do, can't be located", () => {
  const { header, tokens } = load();
  const [{ holder, proof, balance }] = tokens;
  const slots = balanceSlots(holder);
  const weth = checkAccount(header.stateRoot, proof);
  assert.match(reason(locateBalance(slots, weth, undefined)), /balanceOf gave no 32-byte answer: not a token, or the call reverted/);
  assert.match(reason(locateBalance(slots, weth, 0n)), /balanceOf says 0, which every empty slot holds too/);
  assert.match(reason(locateBalance(slots, weth, BigInt(balance) + 1n)), /no balance mapping at indexes 0 to 19 holds \d+/);
  // Another candidate holding the same value: which is the balance can't be told.
  const vyper0 = weth.slots.find((s) => BigInt(s.key) === BigInt(slots[1].key))!;
  vyper0.value = balance;
  assert.match(reason(locateBalance(slots, weth, BigInt(balance))), /2 candidate slots hold \d+, so which is the balance can't be told/);
});
