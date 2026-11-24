// Fetches a block's header and each account's proof at that block, and checks them all.

import { type AccountResult, checkAccount, headerHash } from "./proof.ts";
import type { Header, Proof, Rpc } from "./rpc.ts";

export interface Fetched {
  header: Header;
  proofs: Proof[];
  /** Each account's code, by lowercase address. */
  code: Record<string, string>;
}

export async function collect(rpc: Rpc, block: string, addresses: string[], slots: string[]): Promise<Fetched> {
  const header = await rpc.header(block);
  // Every proof is asked for at the header's own number, so "latest" can't move between calls.
  const fetched: Fetched = { header, proofs: [], code: {} };
  for (const address of addresses) {
    const proof = await rpc.proof(address, slots, header.number);
    fetched.proofs.push(proof);
    fetched.code[proof.address.toLowerCase()] = await rpc.code(address, header.number);
  }
  return fetched;
}

export interface Report {
  block: number;
  hash: string;
  /** The hash the header's fields give, which must be the block hash. */
  rebuilt: string;
  accounts: AccountResult[];
}

export function audit({ header, proofs, code }: Fetched): Report {
  return { block: Number(header.number), hash: header.hash, rebuilt: headerHash(header), accounts: proofs.map((p) => checkAccount(header.stateRoot, p, code[p.address.toLowerCase()])) };
}

export const exitCode = (report: Report) => (report.rebuilt !== report.hash || report.accounts.some((a) => a.problems.length) ? 1 : 0);

const number = (n: number | bigint | string) => BigInt(n).toLocaleString("en-US");
const ether = (wei: string) => (Number(BigInt(wei) / 10n ** 9n) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 });

export function describe(report: Report): string {
  const ok = report.rebuilt === report.hash;
  const lines = [`block ${number(report.block)}, ${report.hash}: ${ok ? "the header hashes to its block hash" : `the header hashes to ${report.rebuilt}, not its block hash`}`];
  for (const a of report.accounts) {
    const code = a.codeSize ? `, ${number(a.codeSize)} bytes of code that hash to its code hash` : "";
    lines.push(a.exists ? `  ${a.address}: an account, ${a.nodes} proof nodes from the state root: nonce ${number(a.nonce)}, balance ${ether(a.balance)} ETH${code}` : `  ${a.address}: no account; ${a.nodes} proof nodes show nothing at this address`);
    for (const s of a.slots) lines.push(`    slot ${s.key}: ${s.value === "0" ? "empty" : `0x${BigInt(s.value).toString(16).padStart(64, "0")}`}, ${s.nodes} proof nodes`);
    for (const p of a.problems) lines.push(`    ${p}`);
  }
  const slots = report.accounts.flatMap((a) => a.slots);
  const good = report.accounts.filter((a) => !a.problems.length);
  lines.push(`  check: ${good.length} of ${report.accounts.length} accounts match their proofs${slots.length ? `, with ${slots.length} slots` : ""}`);
  return lines.join("\n");
}
