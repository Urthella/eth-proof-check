// Saves what the tests run against, all at one mainnet block: its header, and proofs for WETH
// (slot 0 holds its name, slot 0x99 is empty), the beacon deposit contract, and an address no
// account has used, with their code. Run: node scripts/fetch-fixtures.ts [BLOCK]

import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

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
