// Fetches a block's header and each account's proof at that block, and checks them all.

import { type AccountResult, balanceSlots, checkAccount, headerHash, locateBalance } from "./proof.ts";
import type { Header, Proof, Rpc } from "./rpc.ts";

export interface Fetched {
  header: Header;
  proofs: Proof[];
  /** Each account's code, by lowercase address. */
  code: Record<string, string>;
  /** The slots asked for, and with --erc20 the holder and what balanceOf says, by lowercase address. */
  slots: string[];
  erc20?: { holder: string; balances: Record<string, string> };
}

export async function collect(rpc: Rpc, block: string, addresses: string[], slots: string[], holder?: string): Promise<Fetched> {
  const header = await rpc.header(block);
  // Every proof is asked for at the header's own number, so "latest" can't move between calls.
  const fetched: Fetched = { header, proofs: [], code: {}, slots, erc20: holder ? { holder, balances: {} } : undefined };
  // With --erc20, one proof covers every slot the holder's balance could be in.
  const keys = holder ? [...slots, ...balanceSlots(holder).map((s) => s.key)] : slots;
  for (const address of addresses) {
    const proof = await rpc.proof(address, keys, header.number);
    fetched.proofs.push(proof);
    fetched.code[proof.address.toLowerCase()] = await rpc.code(address, header.number);
    if (holder) fetched.erc20!.balances[proof.address.toLowerCase()] = await rpc.balanceOf(address, holder, header.number);
  }
  return fetched;
}

export interface Report {
  block: number;
  hash: string;
  /** The hash the header's fields give, which must be the block hash. */
  rebuilt: string;
  accounts: (AccountResult & { erc20?: Erc20 })[];
  /** The slots asked for with --slot. */
  slots: string[];
}

interface Erc20 {
  holder: string;
  /** What balanceOf said, which only picks the slot. */
  balanceOf: string;
  /** Where the proof holds that balance, or why it couldn't be found. */
  found?: { index: number; layout: string; nodes: number };
  reason?: string;
}

export function audit({ header, proofs, code, slots, erc20 }: Fetched): Report {
  const accounts = proofs.map((p) => {
    const account = checkAccount(header.stateRoot, p, code[p.address.toLowerCase()]);
    if (!erc20) return account;
    const balanceOf = erc20.balances[p.address.toLowerCase()];
    const located = locateBalance(balanceSlots(erc20.holder), account, BigInt(balanceOf));
    const found = typeof located === "string" ? undefined : { index: located.index, layout: located.layout, nodes: located.nodes };
    return { ...account, erc20: { holder: erc20.holder, balanceOf, found, reason: typeof located === "string" ? located : undefined } };
  });
  return { block: Number(header.number), hash: header.hash, rebuilt: headerHash(header), accounts, slots };
}

/** 1 when the header or a proof doesn't hold; 2 when a token balance couldn't be found to prove. */
export const exitCode = (report: Report) => (report.rebuilt !== report.hash || report.accounts.some((a) => a.problems.length) ? 1 : report.accounts.some((a) => a.erc20?.reason) ? 2 : 0);

const number = (n: number | bigint | string) => BigInt(n).toLocaleString("en-US");
const ether = (wei: string) => (Number(BigInt(wei) / 10n ** 9n) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 });

export function describe(report: Report): string {
  const ok = report.rebuilt === report.hash;
  const lines = [`block ${number(report.block)}, ${report.hash}: ${ok ? "the header hashes to its block hash" : `the header hashes to ${report.rebuilt}, not its block hash`}`];
  // --erc20's candidate slots are checked too, but only the ones asked for are shown.
  const asked = (key: string) => report.slots.some((k) => BigInt(k) === BigInt(key));
  for (const a of report.accounts) {
    const code = a.codeSize ? `, ${number(a.codeSize)} bytes of code that hash to its code hash` : "";
    lines.push(a.exists ? `  ${a.address}: an account, ${a.nodes} proof nodes from the state root: nonce ${number(a.nonce)}, balance ${ether(a.balance)} ETH${code}` : `  ${a.address}: no account; ${a.nodes} proof nodes show nothing at this address`);
    for (const s of a.slots.filter((s) => asked(s.key))) lines.push(`    slot ${s.key}: ${s.value === "0" ? "empty" : `0x${BigInt(s.value).toString(16).padStart(64, "0")}`}, ${s.nodes} proof nodes`);
    if (a.erc20?.found) lines.push(`    balance of ${a.erc20.holder}: ${number(a.erc20.balanceOf)}, in the ${a.erc20.found.layout} mapping at index ${a.erc20.found.index}, ${a.erc20.found.nodes} proof nodes`);
    if (a.erc20?.reason) lines.push(`    balance of ${a.erc20.holder}: not found, ${a.erc20.reason}`);
    for (const p of a.problems) lines.push(`    ${p}`);
  }
  const slots = report.accounts.flatMap((a) => a.slots.filter((s) => asked(s.key)));
  const good = report.accounts.filter((a) => !a.problems.length);
  const tokens = report.accounts.filter((a) => a.erc20);
  const balances = tokens.length ? `; ${tokens.filter((a) => a.erc20!.found).length} of ${tokens.length} token balances found and proven` : "";
  lines.push(`  check: ${good.length} of ${report.accounts.length} accounts match their proofs${slots.length ? `, with ${slots.length} slots` : ""}${balances}`);
  return lines.join("\n");
}
