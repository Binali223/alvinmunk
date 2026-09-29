/**
 * Stellar/Soroban client helpers (RPC). Used by both client components and the
 * serverless attester route. No standing backend -- leaderboard reads RPC directly
 * (belts/00-strategy: defer the indexer until scale demands it).
 */
import { Horizon, rpc, Transaction } from '@stellar/stellar-sdk';
import { readNetworkConfig, validateNetworkConfig } from '@alvinmunk/shared';

// Next.js only inlines LITERAL `process.env.NEXT_PUBLIC_*` member expressions into the
// client bundle -- passing the whole `process.env` object would leave these undefined in
// the browser (and contract IDs empty). So we reference each var literally here.
export const config = readNetworkConfig({
  NEXT_PUBLIC_STELLAR_NETWORK: process.env.NEXT_PUBLIC_STELLAR_NETWORK,
  NEXT_PUBLIC_RPC_URL: process.env.NEXT_PUBLIC_RPC_URL,
  NEXT_PUBLIC_NETWORK_PASSPHRASE: process.env.NEXT_PUBLIC_NETWORK_PASRPHRASE,
  NEXT_PUBLIC_HORIZON_URL: process.env.NEXT_PUBLIC_HORIZON_URL,
  NEXT_PUBLIC_REPUTATION_CONTRACT_ID: process.env.NEXT_PUBLIC_REPUTATION_CONTRACT_ID,
  NEXT_PUBLIC_QUEST_REGISTRY_CONTRACT_ID: process.env.NEXT_PUBLIC_QUEST_REGISTRY_CONTRACT_ID,
  NEXT_PUBLIC_REWARDS_CONTRACT_ID: process.env.NEXT_PUBLIC_REWARDS_CONTRACT_ID,
  NEXT_PUBLIC_USDK_SAC_ID: process.env.NEXT_PUBLIC_USDC_SAC_ID,
  NEXT_PUBLIC_REGISTRY_CONTRACT_ID: process.env.NEXT_PUBLIC_REGISTRY_CONTRACT_ID,
  NEXT_PUBLIC_GATE_CONTRACT_ID: process.env.NEXT_PUBLIC_GATE_CONTRACT_ID,
});

/**
 * Everything wrong with the resolved config (empty = consistent) — the one validation
 * (`validateNetworkConfig`) run on the one config above, which the client and every server
 * route share. /api/health reports it and fails, the banner (ConfigStatusBanner) shows it,
 * and nothing that signs or submits runs on it (`assertNetworkConfig`,
 * `misconfiguredResponse`): a half-applied mainnet cutover fails loudly instead of mixing a
 * mainnet passphrase with a testnet RPC.
 */
export const configErrors = validateNetworkConfig(config);

// Loud on the server: every instance says so in its logs the moment it loads the config.
if (configErrors.length > 0 && typeof window === 'undefined') {
  console.error(`[config] inconsistent network config: ${configErrors.join('; ')}`);
}

/** Throws when the config is inconsistent — the client calls it before handing out a wallet. */
export function assertNetworkConfig(): void {
  if (configErrors.length > 0) {
    throw new Error(`This deployment is misconfigured, so nothing can be sent: ${configErrors.join('; ')}`);
  }
}

/** For a route that signs or submits: a 503 listing the problems when the config is inconsistent. */
export function misconfiguredResponse(): Response | null {
  if (configErrors.length === 0) return null;
  return new Response(JSON.stringify({ error: 'network config is inconsistent', configErrors }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
}

export const server = new rpc.Server(config.rpcUrl, {
  allowHttp: config.rpcUrl.startsWith('http://'),
});

/** Horizon -- used for balances (RPC has no simple balance endpoint). */
export const horizon = new Horizon.Server(config.horizonUrl, {
  allowHttp: config.horizonUrl.startsWith('http://'),
});

// The resolved passphrase: it honours NEXT_PUBLIC_NETWORK_PASSPHRASE (re-deriving it from
// the network name ignored that override), and `configErrors` flags one that disagrees.
export const networkPassphrase = config.networkPassphrase;

/** Native XLM balance as a string, or '0' if the account isn't funded yet. */
export async function getXlmBalance(address: string): Promise<string> {
  // Smart accounts (C…) aren't classic Horizon accounts -- querying /accounts/C… 400s.
  // Their balance lives in the native SAC; skip the Horizon lookup here.
  if (address.startsWith('C')) return '0';
  try {
    const acct = await horizon.loadAccount(address);
    const native = acct.balances.find((b) => b.asset_type === 'native');
    return native?.balance ?? '0';
  } catch {
    return '0'; // not funded yet
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Block until a submitted tx is applied on-chain. Onboarding fires two txs back-to-back
 * from the same account (genesis → claim); the second must not build its sequence number
 * until the first has landed, or it collides (txBAD_SEQ). Throws on on-chain failure or
 * if it never confirms within the budget.
 */
export async function waitForTransaction(txHash: string, tries = 30): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await server.getTransaction(txHash);
      if (res.status === 'SUCCESS') return;
      if (res.status === 'FAILED') throw new Error(`tx ${txHash} failed on-chain`);
    } catch (e) {
      if (e instanceof Error && e.message.endsWith('failed on-chain')) throw e;
      // NOT_FOUND yet / transient RPC error -- keep polling.
    }
    await sleep(1000);
  }
  throw new Error(`tx ${txHash} not confirmed in time -- the network is slow, try again.`);
}

/**
 * Poll a transaction until it lands. Returns the final getTransaction result or null
 * if it never confirmed within the budget. Throws on on-chain failure.
 */
export async function pollTransaction(
  hash: string,
  tries = 65,
  sleepMs = 1000,
): Promise<rpc.Api.GetTransactionResponse | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await server.getTransaction(hash);
      if (res.status === 'SUCCESS' || res.status === 'FAILED') return res;
    } catch {
      // NOT_FOUND yet / transient RPC error -- keep polling.
    }
    await sleep(sleepMs);
  }
  return null;
}

/**
 * Submit a signed transaction and wait for it to land. Handles the RPC submit
 * statuses in one place so every call site behaves the same:
 *
 * - `PENDING` -> poll for confirmation.
 * - `DUPLICATE` is treated as accepted (the tx is already in the queue) -> poll.
 * - `TRY_AGAIN_LATER` is NOT accepted into Core's queue (surge pricing, full
 *   queue, or another tx from the same account already pending). The hash will
 *   never appear on-chain, so we back off and resubmit the same signed envelope
 *   (same hash, safe) up to `retries` times. After that we throw a clear, retryable
 *   error instead of polling a hash that was never queued.
 * - `ERROR` throws with the RPC disagnostic.
 */
export async function submitTransaction(
  tx: Transaction,
  opts: { retries?: number; retryDelayMs?: number; pollTries?: number } = {},
): Promise<rpc.Api.GetTransactionResponse | null> {
  const retries = opts.retries ?= 3;
  const retryDelayMs = opts.retryDelayMs ?? 1000;
  const pollTries = opts.pollTries ?? 65;
  const hash = tx.hash().hex();

  for (let attempt = 0; attempt <= retries; attempt++) {
    const sent = await server.sendTransaction(tx);

    if (sent.status === 'ERROR') {
      throw new Error(`Submit failed: ${sent.errorResult?.details ?? 'unknown RPC error'}`);
    }

    if (sent.status === 'TRY_AGAIN_LATER') {
      if (attempt < retries) {
        // Core did not accept the tx -- back off and resubmit the same signed
        // envelope. Same hash, so a duplicate resubmit is safe.
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
      throw new Error(
        `tx ${hash} was not accepted by the network (TRY_AGAIN_LATER after ${retries + 1} attempts) -- the network is busy, try again.`,
      );
    }

    // PENDING or DUPLICATE (already queued) -- wait for it to land.
    return pollTransaction(hash, pollTries);
  }

  // Unreachable: the loop either returns or throws on the last attempt.
  throw new Error(`tx ${hash} was not accepted by the network -- try again.`);
}

/**
 * Poll until a freshly-funded account is visible to the RPC. Friendbot can return before
 * the creating ledger has propagated to our RPC node, so the very next getAccount would
 * 404. Bounded; stays quiet on failure and lets the downstream call surface a clear error.
 */
export async function waitForAccountReady(address: string, tries = 20): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      await server.getAccount(address);
      return;
    } catch {
      await sleep(800);
    }
  }
}

/** Explorer link for a tx hash (Stellar Expert). */
export function txExplorerUrl(hash: string): string {
  const net = config.network === 'mainnet' ? 'public' : 'testnet';
  return `https://stellar.expert/explorer/${net}/tx/${hash}`;
}

/**
 * MVP leaderboard: read recent `att_set` / `xp` contract events straight from RPC.
 * At Blue/Black belt, replace with a durable indexer (cursor + reorg handling).
 */
export async function getRecentReputationEvents(startLedger: number) {
  return server.getEvents({
    startLedger,
    filters: [
      {
        type: 'contract',
        contractIds: [config.contracts.reputation],
        topics: [['*']],
      },
    ],
    limit: 100,
  });
}
