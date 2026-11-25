// Saves what the tests run against, all at one mainnet block: its header, and proofs for WETH
// (slot 0 holds its name, slot 0x99 is empty), the beacon deposit contract, and an address no
// account has used, with their code. Run: node scripts/fetch-fixtures.ts [BLOCK]

import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

import { balanceSlots } from "../src/proof.ts";
import { Rpc } from "../src/rpc.ts";

const rpc = new Rpc("https://ethereum-rpc.publicnode.com");
const header = await rpc.header(process.argv[2] ?? "latest");
const accounts = ["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "0x00000000219ab540356cBB839Cbe05303d7705Fa", "0x00000000000000000000000000000000c0ffee00"];
const proofs = [];
const code: Record<string, string> = {};
for (const a of accounts) {
  proofs.push(await rpc.proof(a, ["0x0", "0x99"], header.number));
  code[a.toLowerCase()] = await rpc.code(a, header.number);
}
writeFileSync(new URL("../test/fixtures/mainnet.json.gz", import.meta.url), gzipSync(JSON.stringify({ header, proofs, code }), { level: 9 }));
console.log(`block ${Number(header.number)}: ${proofs.length} accounts`);

// For --erc20: WETH and USDC held by the Uniswap v3 USDC/WETH pool, and Curve's CRV (a Vyper
// token) held by its vote-escrow contract, proven with every candidate slot, and what balanceOf says.
const pool = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
const pairs = [["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", pool], ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", pool], ["0xd533a949740bb3306d119cc777fa900ba034cd52", "0x5f3b5dfeb7b28cdbd7faba78963ee202a494e2a2"]];
const erc20 = { header, tokens: [] as unknown[] };
for (const [token, holder] of pairs) {
  const proof = await rpc.proof(token, balanceSlots(holder).map((s) => s.key), header.number);
  erc20.tokens.push({ token, holder, proof, balance: await rpc.balanceOf(token, holder, header.number), code: await rpc.code(token, header.number) });
}
writeFileSync(new URL("../test/fixtures/erc20.json.gz", import.meta.url), gzipSync(JSON.stringify(erc20), { level: 9 }));
console.log(`erc20: ${pairs.length} tokens`);
