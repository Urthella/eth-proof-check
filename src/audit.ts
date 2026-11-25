// Fetches a block's header and each account's proof at that block, and checks them all.

import { type AccountResult, type BalanceSlot, balanceSlots, checkAccount, headerHash, locateBalance } from "./proof.ts";
import type { Header, Proof, Rpc } from "./rpc.ts";

export interface Fetched {
  header: Header;
  proofs: Proof[];
  /** Each account's code, by lowercase address. */
  code: Record<string, string>;
  /** The slots asked for with --slot. */
  slots?: string[];
  /** With --erc20: the holder, and what balanceOf said for each token, by lowercase address. */
  erc20?: { holder: string; balanceOf: Record<string, string | undefined> };
}

export async function collect(rpc: Rpc, block: string, addresses: string[], slots: string[], holder?: string): Promise<Fetched> {
  const header = await rpc.header(block);
  // Every proof is asked for at the header's own number, so "latest" can't move between calls.
  const fetched: Fetched = { header, proofs: [], code: {}, slots, erc20: holder ? { holder, balanceOf: {} } : undefined };
  // With --erc20, one proof covers every slot the holder's balance could be in.
  const keys = [...slots, ...(holder ? balanceSlots(holder).map((s) => s.key) : [])];
  for (const address of addresses) {
    const proof = await rpc.proof(address, keys, header.number);
    fetched.proofs.push(proof);
    fetched.code[proof.address.toLowerCase()] = await rpc.code(address, header.number);
    if (holder) fetched.erc20!.balanceOf[proof.address.toLowerCase()] = await rpc.balanceOf(address, holder, header.number);
  }
  return fetched;
}

interface Erc20 {
  holder: string;
  /** What balanceOf said, which only picks the slot. */
  balanceOf?: string;
  /** Where the proof holds that balance, and the value it holds; or why it couldn't be found. */
  found?: BalanceSlot & { value: string; nodes: number };
  reason?: string;
}

export interface Report {
  block: number;
  hash: string;
  /** The hash the header's fields give, which must be the block hash. */
  rebuilt: string;
  accounts: (AccountResult & { erc20?: Erc20 })[];
}

export function audit({ header, proofs, code, slots = [], erc20 }: Fetched): Report {
  const candidates = erc20 ? balanceSlots(erc20.holder) : [];
  const asked = [...slots, ...candidates.map((c) => c.key)];
  const accounts = proofs.map((p) => {
    const address = p.address.toLowerCase();
    const account = checkAccount(header.stateRoot, p, code[address], asked);
    if (!erc20) return account;
    const balanceOf = erc20.balanceOf[address];
    const located = locateBalance(candidates, account, balanceOf === undefined ? undefined : BigInt(balanceOf));
    return { ...account, erc20: { holder: erc20.holder, balanceOf, ...located } };
  });
  return { block: Number(header.number), hash: header.hash, rebuilt: headerHash(header), accounts };
}

/** 1 when the header or a proof doesn't hold; 2 when a token balance couldn't be found to prove. */
export const exitCode = (report: Report) => (report.rebuilt !== report.hash || report.accounts.some((a) => a.problems.length) ? 1 : report.accounts.some((a) => a.erc20?.reason) ? 2 : 0);

const number = (n: number | bigint | string) => BigInt(n).toLocaleString("en-US");
const ether = (wei: string) => (Number(BigInt(wei) / 10n ** 9n) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 });

export function describe(report: Report): string {
  const ok = report.rebuilt === report.hash;
  const lines = [`block ${number(report.block)}, ${report.hash}: ${ok ? "the header hashes to its block hash" : `the header hashes to ${report.rebuilt}, not its block hash`}`];
  let shown = 0;
  for (const a of report.accounts) {
    const code = a.codeSize ? `, ${number(a.codeSize)} bytes of code that hash to its code hash` : "";
    lines.push(a.exists ? `  ${a.address}: an account, ${a.nodes} proof nodes from the state root: nonce ${number(a.nonce)}, balance ${ether(a.balance)} ETH${code}` : `  ${a.address}: no account; ${a.nodes} proof nodes show nothing at this address`);
    // --erc20's candidate slots are checked like the rest, but not listed.
    const candidates = new Set(a.erc20 ? balanceSlots(a.erc20.holder).map((c) => BigInt(c.key)) : []);
    for (const s of a.slots.filter((s) => !candidates.has(BigInt(s.key)))) {
      lines.push(`    slot ${s.key}: ${s.value === "0" ? "empty" : `0x${BigInt(s.value).toString(16).padStart(64, "0")}`}, ${s.nodes} proof nodes`);
      shown++;
    }
    const e = a.erc20;
    if (e?.found) lines.push(`    balance of ${e.holder}: ${number(e.found.value)}, in the ${e.found.layout} mapping at index ${e.found.index}, ${e.found.nodes} proof nodes`);
    if (e?.reason) lines.push(`    balance of ${e.holder}: not found, ${e.reason}`);
    for (const p of a.problems) lines.push(`    ${p}`);
  }
  const good = report.accounts.filter((a) => !a.problems.length);
  const tokens = report.accounts.filter((a) => a.erc20);
  const balances = tokens.length ? `; ${tokens.filter((a) => a.erc20!.found).length} of ${tokens.length} token balances found in them` : "";
  lines.push(`  check: ${good.length} of ${report.accounts.length} accounts match their proofs${shown ? `, with ${shown} slots` : ""}${balances}`);
  return lines.join("\n");
}
