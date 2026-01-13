/**
 * Shared constants for the TEE Swapper
 */

// Order validity duration: 24 hours from submission
export const ORDER_VALIDITY_SECONDS = 24 * 60 * 60;

// GPv2VaultRelayer - the spender address for COWSwap approvals/permits
export const GPV2_VAULT_RELAYER = "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110" as const;

// GPv2Settlement contract address (same on all supported chains)
export const GPV2_SETTLEMENT_ADDRESS = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41" as const;

// CBBTC (Coinbase Wrapped BTC) - the only supported input token
// Uses EIP-2612 permits for gasless approvals
export const CBBTC_ADDRESSES: Record<number, `0x${string}`> = {
  1: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",    // Ethereum Mainnet
  8453: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", // Base
} as const;

/**
 * Check if a token address is CBBTC on the given chain
 */
export function isCbbtc(chainId: number, tokenAddress: string): boolean {
  const cbbtcAddress = CBBTC_ADDRESSES[chainId];
  if (!cbbtcAddress) return false;
  return tokenAddress.toLowerCase() === cbbtcAddress.toLowerCase();
}
