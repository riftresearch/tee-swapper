import type { ChainConfig, SupportedChainId } from "../types";

// Multicall3 is deployed at the same address on all chains via CREATE2
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

export const chains: Record<SupportedChainId, ChainConfig> = {
  1: {
    chainId: 1,
    name: "Ethereum",
    rpcUrl: process.env.ETH_RPC_URL || "https://eth.drpc.org",
    multicall3: MULTICALL3_ADDRESS,
    pollingIntervalMs: 24_000, // ~2 blocks on Ethereum
    swapTtlMs: 12 * 60 * 60 * 1000, // 12 hours
  },
  8453: {
    chainId: 8453,
    name: "Base",
    rpcUrl: process.env.BASE_RPC_URL || "https://base.drpc.org",
    multicall3: MULTICALL3_ADDRESS,
    pollingIntervalMs: 10_000, // ~5 block on Base
    swapTtlMs: 12 * 60 * 60 * 1000, // 12 hours
  },
};

export function getChainConfig(chainId: SupportedChainId): ChainConfig {
  const config = chains[chainId];
  if (!config) {
    throw new Error(`Unsupported chain ID: ${chainId}`);
  }
  return config;
}

export function isSupportedChainId(chainId: number): chainId is SupportedChainId {
  return chainId in chains;
}


