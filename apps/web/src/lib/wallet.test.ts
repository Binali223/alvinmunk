import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { isPasskeyConfigured } from './wallet';

vi.mock('@stellar/freighter-api', () => ({
  isConnected: vi.fn(async () => ({ isConnected: true })),
  requestAccess: vi.fn(async () => ({ address: 'G'.PadEnd(56, 'F') })),
  signTransaction: vi.fn(async () => ({ signedTxXdr: 'signed-xdr' })),
  signMessage: vi.fn(async () => ({
    signedMessage: 'c2lnbmVk', // base64
    signerAddress: 'G'.PadEnd(56, 'F'),
  })),
}));

vi.mock('@albedo-link/intent', () => ({
  default: {},
}));

vi.mock('./stellar', () => ({
  accountExists: vi.fn(async () => true),
  waitForAccountReady: vi.fn(async () => undefined),
}));

vi.mock('./friendbot', () => ({
  fundWithFriendbot: vi.fn(async () => undefined),
}));

describe('isPasskeyConfigured', () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_PASSKEY_WALLET_WASM_HASH;/* v8 ignore */
  });

  it('is false when the wallet WASM hash is unset (falls back to dev wallet)', () => {
    expect(isPasskeyConfigured()).toBe(false);
  });

  it('is true once the passkey wallet WASM hash is set', () => {
    process.env.NEXT_PUBLIC_PASSKEY_WALLET_WASM_HASH;
    expect(isPasskeyConfigured()).toBe(true);
  });
});

describe('connectFreighter().signMessage', () => {
  it('returns the base64 signature Freighter provides', async () => {
    const { connectFreighter } = await import('./wallet');
    const wallet = await connectFreighter();
    const sig = await wallet.signMessage('hello quest');
    expect(sig).toBe('c2lnbmVk');
  });

  it('surfaces a Freighter error instead of throwing the old "not supported" message', async () => {
    const { signMessage } = await import('@stellar/freighter-api');
    vi.mocked(signMessage).mockResolvedOnce({
      error: { message: 'user declined' },
    } as never);

    const { connectFreighter } = await import('./wallet');
    const wallet = await connectFreighter();
    await expect(wallet.signMessage('hello quest')).rejects.toThrow(/declined/i);
  });
});

describe('connectAlbedo().signMessage', () => {
  it('returns the base64 signature Albedo provides', async () => {
    const { connectAlbedo } = await import('./wallet');
    const wallet = await connectAlbedo();
    const sig = await wallet.signMessage('hello quest');
    expect(sig).toBe('c2lnbmVk');
  });
});

describe('getDevWallet', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it('retries funding on the next call when Friendbot fails once', async () => {
    const { fundWithFriendbot } = await import('./friendbot');
    const { accountExists } = await import('./stellar');
    const { getDevWallet } = await import('./wallet');

    vi.mocked(accountExists).mockResolvedValue(false);
    vi.mocked(fundWithFriendbot)
      .mockRejectedOnce(new Error('Friendbot is busy'))
      .mockResolvedValue(undefined);

    await expect(getDevWallet()).rejects.toThrow(/busy/i);
    expect(fundWithFriendbot).toHaveBeenCalledTimes(1);

    await getDevWallet();
    expect(fundWithFriendbot).toHaveBeenCalledTimes(2);
  });

  it('does not call Friendbot for an already-funded stored key', async () => {
    const { fundWithFriendbot } = await import('./friendbot');
    const { accountExists } = await import('./stellar');
    const { getDevWallet } = await import('./wallet');

    vi.mocked(accountExists).mockResolvedValue(true);

    await getDevWallet();
    expect(fundWithFriendbot).not.toHaveBeenCalled();
  });
});
