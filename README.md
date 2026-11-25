# eth-proof-check

Checks Ethereum accounts and storage slots against a block's state root, from the Merkle-Patricia
proofs any node gives with `eth_getProof`, instead of taking the node's word for them. For a block,
`eth-proof-check`:

1. **rebuilds the header** from its fields and checks it hashes to the block hash;
2. **walks each account's proof** from the header's state root, node by node, each node hashing to
   the reference its parent holds, and checks the account it reaches, or its absence, is what the
   node claims: nonce, balance, storage root and code hash;
3. **walks each slot's proof** from the account's storage root the same way;
4. **checks the account's code** from `eth_getCode` hashes to its code hash;
5. with `--erc20 HOLDER`, **proves the holder's token balance** from each token's storage.

It exits 1 if anything doesn't hold.

## Why

A balance from `eth_getBalance` is whatever the node says. A proof is something the node can't
fake: every node of the path hashes into the one above, up to the state root, and the state root
is in the block header, which hashes to the block hash. Trust the block hash, from a light client,
a second node or a checkpoint you know, and you can trust the value.

Wallets, bridges and light clients like Helios do this. `eth-proof-check` does it with no
dependencies, its own Keccak-256 and RLP, so every step can be read:

- **WETH** holds 2,215,862.93 ETH at block 26,485,152, proven by 9 nodes from the state root. Its
  storage slot 0 holds the string "Wrapped Ether", proven by 7 more.
- **An address nobody has used** is proven empty: 8 nodes lead to another account's leaf, whose
  path turns away from this address. An empty slot can end either way: WETH's slot 0x99 at a
  leaf, the deposit contract's at a branch with nothing in its place.
- **A token balance is a storage slot too.** `balanceOf` is code the node runs for you; the
  balance itself sits in a mapping in the token's storage, at `keccak(holder, i)` for Solidity's
  mapping at index *i*, or `keccak(i, holder)` for Vyper's. WETH keeps it at index 3, USDC at 9,
  USDT at 2, and Curve's CRV at Vyper's 3.

## Quick start

Needs Node 24 or later, and nothing else.

```sh
git clone https://github.com/Urthella/eth-proof-check && cd eth-proof-check
node src/main.ts --slot 0 --slot 0x99 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 0x00000000219ab540356cBB839Cbe05303d7705Fa 0x00000000000000000000000000000000c0ffee00
```

```text
block 26,485,152, 0x5297bb85833c39a4abe85ed90de0ee0ef2811e129c569cf4f7eaa2e416867e97: the header hashes to its block hash
  0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2: an account, 9 proof nodes from the state root: nonce 1, balance 2,215,862.931667457 ETH, 3,124 bytes of code that hash to its code hash
    slot 0x0: 0x577261707065642045746865720000000000000000000000000000000000001a, 7 proof nodes
    slot 0x99: empty, 7 proof nodes
  0x00000000219ab540356cbb839cbe05303d7705fa: an account, 8 proof nodes from the state root: nonce 1, balance 93,821,765.19552281 ETH, 6,358 bytes of code that hash to its code hash
    slot 0x0: 0x15f20e2dba5a20c2b66de5f798c79d6c1be14a38a856838330a7049848f3fd76, 2 proof nodes
    slot 0x99: empty, 2 proof nodes
  0x00000000000000000000000000000000c0ffee00: no account; 8 proof nodes show nothing at this address
    slot 0x0: empty, 0 proof nodes
    slot 0x99: empty, 0 proof nodes
  check: 3 of 3 accounts match their proofs, with 6 slots
```

The three accounts are WETH, the beacon chain deposit contract and an unused address.

- `ADDRESS...` are the accounts to check.
- `--slot SLOT` adds a storage slot, decimal or hex, to check in each; repeat it for more.
- `--erc20 HOLDER` treats each address as an ERC-20 token, and proves `HOLDER`'s balance from its
  storage. Here for the Uniswap v3 USDC/WETH pool:

  ```text
  0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48: an account, 9 proof nodes from the state root: nonce 1, balance 0 ETH, 2,186 bytes of code that hash to its code hash
    balance of 0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640: 12,516,451,776,381, in the Solidity mapping at index 9, 7 proof nodes
  ```

  Balances are in the token's smallest unit: 12,516,451.776381 USDC.
- `--block N` picks the block: `latest` by default, or `finalized`, `safe` or a number. Nodes that
  aren't archives keep the state of recent blocks only.
- `--rpc URL` picks the node: `https://ethereum-rpc.publicnode.com` by default. Any EVM chain's
  node that has `eth_getProof` works.
- `--json` prints the report as JSON.

Exit codes: 0 when everything holds, 1 when the header or a proof doesn't, and 2 when it couldn't
check: a node without the block's state, bad arguments, or with `--erc20` a balance it couldn't
find to prove.

## What it does

- **Reads the block's header**, then asks for every proof and code at that header's own number,
  so a new block can't land between calls.
- **The block hash** is the Keccak-256 of the RLP of the header's fields in order, each fork adding
  its own at the end: London's base fee, Shanghai's withdrawals root, Cancun's blob gas and beacon
  root, Prague's requests hash.
- **A proof walk** follows the key's nibbles from the root:
  - each node must hash to the reference its parent holds, and nodes under 32 bytes sit inside
    their parent;
  - a branch picks the next nibble; an extension or leaf carries a run of nibbles in hex-prefix
    encoding;
  - the walk ends at the value, or shows the key isn't there: an empty branch slot, or a path that
    turns away;
  - every node of the proof must be used.
- **The keys** are Keccak-256 of the address for accounts, and of the slot as 32 bytes for
  storage. The account is the RLP of its nonce, balance, storage root and code hash; a slot's value
  is the RLP of its bytes.
- **Every slot asked for must come back proven:** a node that leaves one out fails, exit 1.
- **With `--erc20`**, one proof per token covers the 40 slots the holder's balance could be in:
  - Solidity's and Vyper's mapping at indexes 0 to 19, each checked like any slot.
  - `balanceOf`, through `eth_call`, says which one holds the balance: the value shown is the
    proof's, and `balanceOf` only picks the slot.
  - Some answers can't pick exactly one, and each is reported as not found, exit 2, while the
    other addresses are still checked:
    - a zero balance, since every empty slot holds zero;
    - a balance no candidate holds;
    - a balance two candidates hold;
    - a `balanceOf` that reverts, or doesn't answer with one 32-byte word, as an address that
      isn't a token doesn't.

## How it's checked

- **The building blocks:**
  - RLP against the examples in Ethereum's specification, and round trips;
  - truncated or trailing RLP is refused;
  - a hand-built trie with an extension node, which no saved mainnet path crosses.
- **Real proofs:** one mainnet block's header, and proofs for WETH, the deposit contract and an
  unused address with two slots each, saved by [`scripts/fetch-fixtures.ts`](scripts/fetch-fixtures.ts).
  - The header rebuilds to its hash, and every account, slot and code checks out.
  - Then they're broken: a claimed balance, nonce or slot value; a node that doesn't hash to its
    parent's reference; a node too many; a node too few; code that doesn't match. Each fails.
- **End to end:** the CLI runs against a fake node serving that block:
  - accounts and slots are checked, all at the header's block;
  - a claimed balance the proof doesn't hold exits 1, and so does a header with another state root;
  - a rate-limited node is asked again;
  - a node without the state, bad arguments and an unreachable node exit 2.
- **Token balances:** WETH and USDC held by the Uniswap v3 pool, and CRV held by Curve's
  vote-escrow contract, saved with all their candidate slots.
  - Each is found at its mapping, Vyper's for CRV, and proven.
  - No answer, a zero balance, a balance no slot holds, or one two slots hold, isn't found.
  - A slot the node was asked for and left out fails.
  - End to end, `--erc20` lists only the balance, not the candidates, with the proof's value in
    the JSON. A `balanceOf` that no slot backs, that reverts, or that answers `0x` exits 2, and
    the other tokens are still found.
- **Mutation testing:** thirty-nine deliberate bugs were planted one at a time, and the tests
  caught every one.
- **Live**, on 2026-11-24 from publicnode:
  - at block 26,485,152, WETH, the deposit contract and an unused address, all as above;
  - at block 26,485,204, the pool's WETH, USDC and USDT, at indexes 3, 9 and 2. It held no DAI,
    so that one was reported not found.

## Limits

- **The block hash is the root of trust.** This proves values against the block the node names;
  it doesn't check the block is part of the chain. Compare the hash with a source you trust, or
  follow the chain with a light client.
- **Proofs need the state.** Most public nodes keep recent blocks' state only, about the last 128.
- **Only Merkle-Patricia tries.** Ethereum has used them since launch; a move to another tree
  would need new proofs.
- **`--erc20` trusts `balanceOf` to pick the slot**, not for the value. A node that lies could
  point it at another mapping keyed by the holder, and the slot's index is shown so you can
  check. Tokens that keep balances elsewhere aren't found:
  - in namespaced storage (ERC-7201, as OpenZeppelin's upgradeable contracts do);
  - past index 19;
  - as shares, like stETH.

## License

MIT
