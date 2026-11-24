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

test("a mapping at index i puts a holder at keccak(holder, i), or keccak(i, holder) in Vyper", () => {
  const holder = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
  const slots = balanceSlots(holder);
  assert.equal(slots.length, 40);
  const solidity3 = slots.find((s) => s.index === 3 && s.layout === "Solidity")!;
  assert.equal(solidity3.key, `0x${keccak256(Buffer.from(pad(holder) + pad("3"), "hex")).toString("hex")}`);
  const vyper3 = slots.find((s) => s.index === 3 && s.layout === "Vyper")!;
  assert.equal(vyper3.key, `0x${keccak256(Buffer.from(pad("3") + pad(holder), "hex")).toString("hex")}`);
});

test("real tokens' balances are found at their mapping and proven", () => {
  const { header, tokens } = load();
  const found = tokens.map(({ token, holder, proof, balance }) => {
    const account = checkAccount(header.stateRoot, proof);
    assert.deepEqual(account.problems, [], token);
    const located = locateBalance(balanceSlots(holder), account, BigInt(balance));
    assert.ok(typeof located !== "string", `${token}: ${located}`);
    assert.equal(located.value, BigInt(balance));
    return `${located.layout} ${located.index}`;
  });
  // WETH9 declares name, symbol and decimals before balanceOf, and so does CRV, in Vyper; USDC's
  // FiatToken keeps balances at 9.
  assert.deepEqual(found, ["Solidity 3", "Solidity 9", "Vyper 3"]);
});

test("a balance no candidate slot holds, or a zero balance, can't be located", () => {
  const { header, tokens } = load();
  const [{ holder, proof, balance }] = tokens;
  const weth = checkAccount(header.stateRoot, proof);
  assert.match(locateBalance(balanceSlots(holder), weth, BigInt(balance) + 1n) as string, /no balance mapping at indexes 0 to 19 holds \d+/);
  assert.match(locateBalance(balanceSlots(holder), weth, 0n) as string, /balanceOf says 0, which every empty slot holds too/);
});
