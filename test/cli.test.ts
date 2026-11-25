// Runs the real CLI against a fake Ethereum node serving the saved block and proofs, which can be
// told to misbehave.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import type { Header, Proof } from "../src/rpc.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const { header, proofs, code }: { header: Header; proofs: Proof[]; code: Record<string, string> } = JSON.parse(gunzipSync(readFileSync(new URL("fixtures/mainnet.json.gz", import.meta.url))).toString());
const [WETH, DEPOSIT, UNUSED] = proofs.map((p) => p.address);

const erc20: { header: Header; tokens: { token: string; holder: string; proof: Proof; balance: string; code: string }[] } = JSON.parse(gunzipSync(readFileSync(new URL("fixtures/erc20.json.gz", import.meta.url))).toString());
const [POOL, VECRV] = [erc20.tokens[0].holder, erc20.tokens[2].holder];
const [, USDC, CRV] = erc20.tokens.map((t) => t.token);

let rateLimits = 0;
let richer = false;
let otherRoot = false;
/** Serve the --erc20 block and tokens instead. */
let tokenMode = false;
let lyingBalanceOf = false;
/** balanceOf on WETH reverts, or answers "0x" as an address with no code does. */
let reverting: false | "revert" | "empty" = false;
/** eth_getProof leaves out the first slot it was asked for. */
let leaveOut = false;
const asked: unknown[][] = [];

const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const { id, method, params } = JSON.parse(body);
  asked.push([method, ...params]);
  const reply = (status: number, payload: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
  if (rateLimits > 0) {
    rateLimits--;
    return reply(429, {});
  }
  const ok = (result: unknown) => reply(200, { jsonrpc: "2.0", id, result });
  if (tokenMode) {
    const t = erc20.tokens.find((x) => x.token === (method === "eth_call" ? params[0].to : params[0])?.toLowerCase());
    if (method === "eth_getBlockByNumber") return ok(erc20.header);
    if (method === "eth_getCode") return ok(t!.code);
    if (method === "eth_call") {
      if (reverting && t?.token === WETH) return reverting === "revert" ? reply(200, { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted" } }) : ok("0x");
      const holder = `0x${params[0].data.slice(-40)}`;
      const balance = t && t.holder === holder ? BigInt(t.balance) + (lyingBalanceOf ? 1n : 0n) : 0n;
      return ok(`0x${balance.toString(16).padStart(64, "0")}`);
    }
    if (method === "eth_getProof") return ok({ ...t!.proof, storageProof: (params[1] as string[]).slice(leaveOut ? 1 : 0).map((k) => t!.proof.storageProof.find((s) => BigInt(s.key) === BigInt(k))!) });
  }
  if (method === "eth_getBlockByNumber") return ok(otherRoot ? { ...header, stateRoot: `0x${"11".repeat(32)}` } : header);
  if (method === "eth_getCode") return ok(code[params[0].toLowerCase()]);
  if (method === "eth_getProof") {
    const proof = proofs.find((p) => p.address === params[0].toLowerCase());
    if (!proof) return reply(200, { jsonrpc: "2.0", id, error: { code: -32000, message: "missing trie node" } });
    const slots = (params[1] as string[]).map((s) => proof.storageProof.find((x) => x.key === s) ?? { key: s, value: "0x0", proof: [] });
    return ok({ ...proof, balance: richer && proof.address === WETH ? "0xffffffffffff" : proof.balance, storageProof: slots });
  }
  reply(200, { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
server.unref();
const RPC = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [MAIN, "--rpc", RPC, ...args], (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, stdout, stderr }));
  });
}

test("checks accounts and slots at one block, exit 0", async () => {
  asked.length = 0;
  const { code: exit, stdout, stderr } = await run("--slot", "0", "--slot", "0x99", WETH, DEPOSIT, UNUSED);
  assert.equal(exit, 0, stderr);
  assert.match(stdout, new RegExp(`^block ${Number(header.number).toLocaleString("en-US")}, ${header.hash}: the header hashes to its block hash\n`));
  assert.match(stdout, /\n  0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2: an account, 9 proof nodes from the state root: nonce 1, balance [\d,.]+ ETH, [\d,]+ bytes of code that hash to its code hash\n    slot 0x0: 0x577261707065642045746865720000000000000000000000000000000000001a, 7 proof nodes\n    slot 0x99: empty, 7 proof nodes\n/);
  assert.match(stdout, /\n  0x00000000000000000000000000000000c0ffee00: no account; \d+ proof nodes show nothing at this address\n/);
  assert.match(stdout, /\n  check: 3 of 3 accounts match their proofs, with 6 slots$/m);
  const blocks = asked.filter(([m]) => m !== "eth_getBlockByNumber").map((call) => call.at(-1));
  assert.deepEqual([...new Set(blocks)], [header.number], "every proof and code at the header's own block");
});

test("--json prints the report", async () => {
  const { code: exit, stdout } = await run("--json", "--block", String(Number(header.number)), WETH);
  assert.equal(exit, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.rebuilt, header.hash);
  assert.equal(report.accounts[0].nonce, "1");
  assert.deepEqual(asked.at(-3), ["eth_getBlockByNumber", header.number, false], "a decimal --block is sent as hex");
});

test("a balance the proof doesn't hold exits 1 and says so", async () => {
  richer = true;
  try {
    const { code: exit, stdout } = await run(WETH);
    assert.equal(exit, 1, stdout);
    assert.match(stdout, /\n    the node claims balance 281474976710655, the proof holds \d+\n/);
  } finally {
    richer = false;
  }
});

test("a header that doesn't hash to its block hash exits 1, and proofs don't reach its root", async () => {
  otherRoot = true;
  try {
    const { code: exit, stdout } = await run(WETH);
    assert.equal(exit, 1, stdout);
    assert.match(stdout, /: the header hashes to 0x[0-9a-f]{64}, not its block hash\n/);
    assert.match(stdout, /account proof: proof node 0 doesn't hash to the reference before it/);
  } finally {
    otherRoot = false;
  }
});

test("--erc20 proves each token's balance from its storage, Vyper's mapping too", async () => {
  tokenMode = true;
  try {
    const { code: exit, stdout, stderr } = await run("--erc20", POOL, WETH, USDC);
    assert.equal(exit, 0, stderr);
    assert.match(stdout, new RegExp(`\n    balance of ${POOL}: [\\d,]+, in the Solidity mapping at index 3, \\d+ proof nodes\n`));
    assert.match(stdout, new RegExp(`\n    balance of ${POOL}: [\\d,]+, in the Solidity mapping at index 9, \\d+ proof nodes\n`));
    assert.match(stdout, /check: 2 of 2 accounts match their proofs; 2 of 2 token balances found in them$/m);
    const json = JSON.parse((await run("--json", "--erc20", POOL, WETH)).stdout);
    assert.deepEqual([json.accounts[0].erc20.found.index, json.accounts[0].erc20.found.layout], [3, "Solidity"]);
    assert.equal(json.accounts[0].erc20.found.value, erc20.tokens[0].balance, "the proven value is in the report");
    assert.doesNotMatch(stdout, /\n    slot /, "the candidate slots aren't listed");
    const vyper = await run("--erc20", VECRV, CRV);
    assert.equal(vyper.code, 0, vyper.stderr);
    assert.match(vyper.stdout, /in the Vyper mapping at index 3, \d+ proof nodes\n/);
  } finally {
    tokenMode = false;
  }
});

test("a balanceOf no candidate slot holds can't be proven, exit 2", async () => {
  tokenMode = lyingBalanceOf = true;
  try {
    const { code: exit, stdout } = await run("--erc20", POOL, WETH);
    assert.equal(exit, 2, stdout);
    assert.match(stdout, /balance of 0x[0-9a-f]{40}: not found, no balance mapping at indexes 0 to 19 holds \d+, what balanceOf says\n/);
  } finally {
    tokenMode = lyingBalanceOf = false;
  }
});

test("a node that leaves out a candidate slot hasn't proven it, exit 1", async () => {
  tokenMode = leaveOut = true;
  try {
    const { code: exit, stdout } = await run("--erc20", POOL, WETH);
    assert.equal(exit, 1, stdout);
    assert.match(stdout, /\n    the node left out slot 0x[0-9a-f]{64}\n/);
  } finally {
    tokenMode = leaveOut = false;
  }
});

test("a token whose balanceOf reverts, or answers nothing, is reported not found, and the rest still are, exit 2", async () => {
  tokenMode = true;
  try {
    for (const mode of ["revert", "empty"] as const) {
      reverting = mode;
      const { code: exit, stdout } = await run("--erc20", POOL, WETH, USDC);
      assert.equal(exit, 2, stdout);
      assert.match(stdout, /balance of 0x[0-9a-f]{40}: not found, balanceOf gave no 32-byte answer: not a token, or the call reverted\n/, mode);
      assert.match(stdout, /in the Solidity mapping at index 9/, "USDC is still found");
    }
  } finally {
    tokenMode = false;
    reverting = false;
  }
});

test("a node that rate-limits is asked again", async () => {
  rateLimits = 2;
  const { code: exit, stderr } = await run(UNUSED);
  assert.equal(exit, 0, stderr);
  assert.equal(rateLimits, 0);
});

test("a node without the state exits 2 with its reason", async () => {
  const { code: exit, stderr } = await run("0x1111111111111111111111111111111111111111");
  assert.equal(exit, 2);
  assert.match(stderr, /eth-proof-check: eth_getProof: missing trie node/);
});

test("bad arguments and an unreachable node exit 2", async () => {
  for (const args of [[], ["0x1234"], ["--erc20", "0x1234", WETH], ["--block", "yesterday", WETH], ["--slot", "x", WETH], ["--slot", `0x1${"0".repeat(64)}`, WETH], ["--depth", "1", WETH]]) {
    const bad = await run(...args);
    assert.equal(bad.code, 2, `${args}: ${bad.stderr}`);
    assert.match(bad.stderr, /usage: eth-proof-check/);
  }
  const closed = await new Promise<number>((resolve) => execFile(process.execPath, [MAIN, "--rpc", "http://127.0.0.1:1", WETH], (error) => resolve(error ? Number(error.code) : 0)));
  assert.equal(closed, 2);
});
