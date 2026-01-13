import {
  type Address,
  type PublicClient,
  erc20Abi,
  getContract,
} from "viem";
import type { Token } from "../types";
import { getTokenAddress, isEtherToken } from "../types";
import { deserializeToken } from "../utils/token";
import type { Swap } from "../db/schema";

// Maximum addresses to query in a single multicall
const MULTICALL_BATCH_SIZE = 7500;

/**
 * Batch get balances for multiple swaps using multicall
 * Returns balances in the same order as input swaps
 *
 * Automatically chunks into batches of MULTICALL_BATCH_SIZE to avoid
 * RPC limits and timeouts.
 */
export async function batchGetBalances(
  client: PublicClient,
  swaps: Swap[]
): Promise<bigint[]> {
  if (swaps.length === 0) return [];

  const results: bigint[] = [];

  // Process in chunks to avoid RPC limits
  for (let i = 0; i < swaps.length; i += MULTICALL_BATCH_SIZE) {
    const chunk = swaps.slice(i, i + MULTICALL_BATCH_SIZE);

    const contracts = chunk.map((swap) => {
      const sellToken = deserializeToken(swap.sellToken);
      if (isEtherToken(sellToken)) {
        throw new Error("Ether token not supported for balanceOf");
      }
      return {
        address: getTokenAddress(sellToken) as Address,
        abi: erc20Abi,
        functionName: "balanceOf" as const,
        args: [swap.vaultAddress as Address] as const,
      };
    });

    const chunkResults = await client.multicall({
      contracts,
      allowFailure: true,
    });

    for (const result of chunkResults) {
      if (result && result.status === "success") {
        results.push(result.result as bigint);
      } else {
        results.push(0n);
      }
    }
  }

  return results;
}

/**
 * Get balance for a single address/token combination
 */
export async function getBalance(
  client: PublicClient,
  address: Address,
  token: Token
): Promise<bigint> {
  const contract = getContract({
    address: getTokenAddress(token) as Address,
    abi: erc20Abi,
    client,
  });

  try {
    return await contract.read.balanceOf([address]);
  } catch {
    return 0n;
  }
}
