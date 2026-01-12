/**
 * Shared constants for the TEE Swapper
 */

// Order validity duration: 24 hours from submission
export const ORDER_VALIDITY_SECONDS = 24 * 60 * 60;

// Internal sentinel address for native ETH (used by some external APIs)
// Note: Our public API uses "ETH" instead of this address
export const NATIVE_ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as const;

// GPv2VaultRelayer - the spender address for COWSwap approvals/permits
export const GPV2_VAULT_RELAYER = "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110" as const;

// GPv2Settlement contract address (same on all supported chains)
export const GPV2_SETTLEMENT_ADDRESS = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41" as const;

// Minimum ETH sell amount in wei (0.001 ETH) - below this, gas costs dominate
export const MIN_ETH_SELL_AMOUNT = 1000000000000000n; // 0.001 ETH

// Gas buffer multiplier for transaction estimation (20% extra)
export const GAS_BUFFER_PERCENT = 120;
