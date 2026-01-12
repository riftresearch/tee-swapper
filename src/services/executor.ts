import { match } from "ts-pattern";
import type { PublicClient } from "viem";
import type { Swap } from "../db/schema";
import type { ExecutionResult } from "../types";
import { detectSwapFlow } from "./tokens";
import { executeEthFlow } from "./flows/ethflow";
import { executePermitFlow } from "./flows/permit";
import { executeLegacyFlow } from "./flows/legacy";

/**
 * Execute a swap using the appropriate flow based on token type
 *
 * Flow selection:
 * - Native ETH (0xEeee...) → EthFlow contract
 * - ERC-20 tokens → Try permit flow, fall back to legacy if not supported
 */
export async function executeSwap(
  swap: Swap,
  client: PublicClient
): Promise<ExecutionResult> {
  const flow = detectSwapFlow(swap);

  console.log(`[Executor] Swap ${swap.swapId} detected as ${flow.type} flow`);

  return match(flow)
    .with({ type: "native_eth" }, () => executeEthFlow(swap, client))
    .with({ type: "permit_erc20" }, async () => {
      try {
        return await executePermitFlow(swap, null, client);
      } catch (error) {
        // If permit flow fails (token doesn't support permits), fall back to legacy
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("does not support permits")) {
          console.log(`[Executor] Permit not supported, falling back to legacy flow`);
          return executeLegacyFlow(swap);
        }
        // Re-throw other errors
        throw error;
      }
    })
    .with({ type: "legacy_erc20" }, () => executeLegacyFlow(swap))
    .exhaustive();
}
