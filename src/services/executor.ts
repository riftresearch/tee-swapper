import type { PublicClient } from "viem";
import type { Swap } from "../db/schema";
import type { ExecutionResult } from "../types";
import { executePermitFlow } from "./flows/permit";

/**
 * Execute a swap using the permit flow (EIP-2612)
 *
 * This service only supports ERC20 tokens with permit capability (like CBBTC).
 *
 * @param swap - The swap record
 * @param sellAmount - The actual amount of CBBTC to sell (vault balance)
 * @param client - Viem public client for the chain
 */
export async function executeSwap(
  swap: Swap,
  sellAmount: bigint,
  client: PublicClient
): Promise<ExecutionResult> {
  console.log(`[Executor] Executing swap ${swap.swapId} via permit flow, amount: ${sellAmount}`);
  return executePermitFlow(swap, sellAmount, client);
}
