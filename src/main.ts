#!/usr/bin/env node
// eth-proof-check: checks Ethereum accounts and storage slots against a block's state root, from
// eth_getProof's Merkle-Patricia proofs and a header that must hash to its block hash. Exits 1 if
// a proof doesn't hold, 2 if it couldn't check.

import { parseArgs } from "node:util";

import { audit, collect, describe, exitCode } from "./audit.ts";
import { Rpc } from "./rpc.ts";

const USAGE = "usage: eth-proof-check [--rpc URL] [--block N|latest|finalized|safe] [--slot SLOT]... [--erc20 HOLDER] [--json] ADDRESS...";
const MAX_SLOT = (1n << 256n) - 1n;

async function main(): Promise<number> {
  let values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        rpc: { type: "string", default: "https://ethereum-rpc.publicnode.com" },
        block: { type: "string", default: "latest" },
        slot: { type: "string", multiple: true, default: [] },
        erc20: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.error(USAGE);
    return 0;
  }
  const bad = (why: string) => {
    console.error(`${why}\n${USAGE}`);
    return 2;
  };
  if (!positionals.length) return bad("no address given");
  const invalid = [...positionals, ...(values.erc20 === undefined ? [] : [values.erc20])].find((a) => !/^0x[0-9a-fA-F]{40}$/.test(a));
  if (invalid) return bad(`not an address: ${invalid}`);
  if (!/^(latest|finalized|safe|\d+)$/.test(values.block)) return bad(`--block must be a number, latest, finalized or safe: ${values.block}`);
  const block = /^\d+$/.test(values.block) ? `0x${BigInt(values.block).toString(16)}` : values.block;
  const slots: string[] = [];
  for (const s of values.slot) {
    const n = /^(0x[0-9a-fA-F]+|\d+)$/.test(s) ? BigInt(s) : -1n;
    if (n < 0n || n > MAX_SLOT) return bad(`--slot must be a number below 2^256: ${s}`);
    slots.push(`0x${n.toString(16)}`);
  }
  try {
    const report = audit(await collect(new Rpc(values.rpc), block, positionals, slots, values.erc20?.toLowerCase()));
    console.log(values.json ? JSON.stringify(report, null, 2) : describe(report));
    return exitCode(report);
  } catch (error) {
    console.error(`eth-proof-check: ${(error as Error).message}`);
    return 2;
  }
}

// Not process.exit(): it can trip a libuv assertion on Windows.
process.exitCode = await main();
