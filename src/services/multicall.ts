import {
  type Address,
  type PublicClient,
  erc20Abi,
  getContract,
} from "viem";
import { isNativeToken, type Token, type TokenAddress } from "../types";
import { deserializeToken } from "../utils/token";
import type { Swap } from "../db/schema";

/**
 * Batch get balances for multiple swaps using multicall
 * Returns balances in the same order as input swaps
 */
export async function batchGetBalances(
  client: PublicClient,
  swaps: Swap[]
): Promise<bigint[]> {
  if (swaps.length === 0) return [];

  // Separate native ETH and ERC20 swaps
  const ethSwaps: { index: number; swap: Swap }[] = [];
  const erc20Swaps: { index: number; swap: Swap }[] = [];

  swaps.forEach((swap, index) => {
    const sellToken = deserializeToken(swap.sellToken);
    if (isNativeToken(sellToken)) {
      ethSwaps.push({ index, swap });
    } else {
      erc20Swaps.push({ index, swap });
    }
  });

  // Initialize results array
  const results: bigint[] = new Array(swaps.length).fill(0n);

  // Fetch ETH balances
  if (ethSwaps.length > 0) {
    const ethBalances = await Promise.all(
      ethSwaps.map(({ swap }) =>
        client.getBalance({ address: swap.depositAddress as Address })
      )
    );
    ethSwaps.forEach(({ index }, i) => {
      const balance = ethBalances[i];
      results[index] = balance ?? 0n;
    });
  }

  // Fetch ERC20 balances via multicall
  if (erc20Swaps.length > 0) {
    const contracts = erc20Swaps.map(({ swap }) => {
      const sellToken = deserializeToken(swap.sellToken);
      // Safe to access .address since we filtered native ETH above
      const tokenAddress = isNativeToken(sellToken) ? null : sellToken.address;
      return {
        address: tokenAddress as Address,
        abi: erc20Abi,
        functionName: "balanceOf" as const,
        args: [swap.depositAddress as Address] as const,
      };
    });

    const erc20Results = await client.multicall({
      contracts,
      allowFailure: true,
    });

    erc20Swaps.forEach(({ index }, i) => {
      const result = erc20Results[i];
      if (result && result.status === "success") {
        results[index] = result.result as bigint;
      } else {
        // If call failed, balance is 0
        results[index] = 0n;
      }
    });
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
  if (isNativeToken(token)) {
    return client.getBalance({ address });
  }

  const contract = getContract({
    address: token.address,
    abi: erc20Abi,
    client,
  });

  try {
    return await contract.read.balanceOf([address]);
  } catch {
    return 0n;
  }
}
