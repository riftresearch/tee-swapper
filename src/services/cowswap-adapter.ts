/**
 * COW SDK Adapter Configuration
 *
 * The COW SDK requires a global adapter to be configured before using
 * functions like OrderSigningUtils.signOrder. This module sets up the
 * viem-based adapter for the SDK.
 */

import { setGlobalAdapter } from "@cowprotocol/sdk-common";
import { ViemAdapter } from "@cowprotocol/sdk-viem-adapter";
import { http, createPublicClient } from "viem";
import { mainnet, base } from "viem/chains";

// Create public clients for each chain
const clients = {
  1: createPublicClient({
    chain: mainnet,
    transport: http(),
  }),
  8453: createPublicClient({
    chain: base,
    transport: http(),
  }),
};

// Create and configure the viem adapter with mainnet client as default
// The adapter uses this client for contract interactions and signing
const viemAdapter = new ViemAdapter({
  provider: clients[1],
});

/**
 * Initialize the COW SDK global adapter
 * This must be called before using any COW SDK functions that require signing
 */
export function initCowSdkAdapter(): void {
  setGlobalAdapter(viemAdapter);
  console.log("[COW SDK] Viem adapter initialized");
}
