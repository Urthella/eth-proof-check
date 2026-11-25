// A small Ethereum JSON-RPC client, with the few calls a proof check needs.

const ATTEMPTS = 4;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** An error the node answered with, as opposed to not answering. */
export class RpcError extends Error {}

/** A block header as eth_getBlockByNumber returns it. */
export type Header = Record<string, string> & { hash: string; number: string; stateRoot: string };

export interface Proof {
  address: string;
  balance: string;
  nonce: string;
  codeHash: string;
  storageHash: string;
  accountProof: string[];
  storageProof: { key: string; value: string; proof: string[] }[];
}

export class Rpc {
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "eth-proof-check" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
      // Public nodes answer bursts with 429; wait and ask again.
      if ((response.status === 429 || response.status >= 500) && attempt < ATTEMPTS) {
        await response.body?.cancel();
        await sleep(1000 * attempt);
        continue;
      }
      if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
      const body = (await response.json()) as { result?: T; error?: { message: string } };
      if (body.error) throw new RpcError(`${method}: ${body.error.message}`);
      if (body.result === undefined || body.result === null) throw new Error(`${method}: no result`);
      return body.result;
    }
  }

  header = (block: string) => this.call<Header>("eth_getBlockByNumber", [block, false]);
  proof = (address: string, slots: string[], block: string) => this.call<Proof>("eth_getProof", [address, slots, block]);
  code = (address: string, block: string) => this.call<string>("eth_getCode", [address, block]);
  /** ERC-20 balanceOf(holder), as the node computes it: only a hint, never the answer. */
  async balanceOf(token: string, holder: string, block: string): Promise<string | undefined> {
    try {
      const word = await this.call<string>("eth_call", [{ to: token, data: `0x70a08231${holder.slice(2).toLowerCase().padStart(64, "0")}` }, block]);
      // An address with no code answers "0x"; anything but one 32-byte word isn't a balance.
      return /^0x[0-9a-fA-F]{64}$/.test(word) ? String(BigInt(word)) : undefined;
    } catch (error) {
      // A revert is an answer: not a balance. A node that doesn't answer still stops the run.
      if (error instanceof RpcError) return undefined;
      throw error;
    }
  }
}
