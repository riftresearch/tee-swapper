/**
 * End-to-end integration tests for swap flows on Base chain.
 *
 * These tests use real blockchain transactions and require:
 * - TEST_PRIVATE_KEY in .env (funded account with ETH, USDC, USDT on Base)
 * - BASE_RPC_URL in .env (or uses default public RPC)
 *
 * Run with: bun test tests/e2e/swap-flows.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  type Address,
  erc20Abi,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../../src/app";
import { startAllPollers, stopAllPollers } from "../../src/services/poller";
import { startSettlementPoller, stopSettlementPoller } from "../../src/services/settlement";
import { initCowSdkAdapter } from "../../src/services/cowswap-adapter";
import { setupPersistentTestDatabase } from "./db-persistent";
import type { CreateSwapResponse, SwapStatusResponse, QuoteResponse } from "../../src/types";

// Base chain token addresses (raw addresses for balance checks and transfers)
const TOKEN_ADDRESSES = {
  ETH: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as const,
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const,
  USDT: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2" as const,
} as const;

// Token objects for API requests (tagged union format)
const TOKENS = {
  ETH: { type: "native" as const },
  USDC: { type: "erc20" as const, address: TOKEN_ADDRESSES.USDC },
  USDT: { type: "erc20" as const, address: TOKEN_ADDRESSES.USDT },
} as const;

// Test amounts
const TEST_AMOUNTS = {
  ETH: parseUnits("0.003", 18),   // 0.003 ETH
  USDC: parseUnits("9", 6),       // 9 USDC
  USDT: parseUnits("3", 6),       // 3 USDT (reduced - legacy flow expected to fail anyway)
} as const;

// Polling configuration
const POLL_INTERVAL_MS = 5_000;     // 5 seconds
const MAX_POLL_TIME_MS = 300_000;   // 5 minutes timeout

type TestApp = ReturnType<typeof createApp>;

/**
 * Helper to make requests to the test app
 */
async function request(
  app: TestApp,
  path: string,
  options: {
    method?: "GET" | "POST";
    body?: unknown;
  } = {}
): Promise<Response> {
  const { method = "GET", body } = options;
  const requestInit: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) {
    requestInit.body = JSON.stringify(body);
  }
  return app.handle(new Request(`http://localhost${path}`, requestInit));
}

/**
 * Poll swap status until complete or timeout
 */
async function pollUntilComplete(
  app: TestApp,
  swapId: string
): Promise<SwapStatusResponse> {
  const startTime = Date.now();

  while (Date.now() - startTime < MAX_POLL_TIME_MS) {
    const response = await request(app, `/swap/${swapId}`);
    const status = (await response.json()) as SwapStatusResponse;

    console.log(`[Poll] Swap ${swapId} status: ${status.status}`);

    if (status.status === "complete") {
      return status;
    }

    if (status.status === "failed" || status.status === "expired" || status.status === "refund_pending") {
      throw new Error(`Swap ${swapId} ended with status: ${status.status}${status.failureReason ? ` - ${status.failureReason}` : ""}`);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`Swap ${swapId} timed out after ${MAX_POLL_TIME_MS}ms`);
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Get ERC20 token balance
 */
async function getTokenBalance(
  client: any,
  token: Address,
  account: Address
): Promise<bigint> {
  if (token.toLowerCase() === TOKEN_ADDRESSES.ETH.toLowerCase()) {
    return client.getBalance({ address: account });
  }

  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account],
  });
}

/**
 * Send ERC20 tokens
 */
async function sendTokens(
  walletClient: any,
  publicClient: any,
  token: Address,
  to: Address,
  amount: bigint
): Promise<`0x${string}`> {
  const account = walletClient.account;
  if (!account) throw new Error("Wallet client has no account");

  if (token.toLowerCase() === TOKEN_ADDRESSES.ETH.toLowerCase()) {
    // Send native ETH
    const hash = await walletClient.sendTransaction({
      account,
      chain: base,
      to,
      value: amount,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  // Send ERC20
  const hash = await walletClient.writeContract({
    account,
    chain: base,
    address: token,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, amount],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

describe("E2E Swap Flows (Base Chain)", () => {
  let app: TestApp;
  let publicClient: any;
  let walletClient: any;
  let testAccount: Address;

  beforeAll(async () => {
    // Validate environment
    const privateKey = process.env.TEST_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error("TEST_PRIVATE_KEY not set in environment");
    }

    // Set up clients
    const rpcUrl = process.env.BASE_RPC_URL || "https://base.drpc.org";
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    testAccount = account.address;

    publicClient = createPublicClient({
      chain: base,
      transport: http(rpcUrl),
    });

    walletClient = createWalletClient({
      account,
      chain: base,
      transport: http(rpcUrl),
    });

    console.log(`[Setup] Test account: ${testAccount}`);

    // Check balances
    const ethBalance = await getTokenBalance(publicClient, TOKEN_ADDRESSES.ETH, testAccount);
    const usdcBalance = await getTokenBalance(publicClient, TOKEN_ADDRESSES.USDC, testAccount);

    console.log(`[Setup] ETH balance: ${formatUnits(ethBalance, 18)} ETH`);
    console.log(`[Setup] USDC balance: ${formatUnits(usdcBalance, 6)} USDC`);

    // Validate sufficient balances
    if (ethBalance < TEST_AMOUNTS.ETH + parseUnits("0.01", 18)) {
      throw new Error("Insufficient ETH balance for tests (need 0.003 + gas)");
    }
    if (usdcBalance < TEST_AMOUNTS.USDC) {
      throw new Error("Insufficient USDC balance for tests");
    }

    // Initialize COW SDK adapter
    initCowSdkAdapter();

    // Set up persistent test database (data retained for inspection)
    await setupPersistentTestDatabase();
    app = createApp();

    // Start pollers for deposit detection and settlement tracking
    startAllPollers();
    startSettlementPoller();
    console.log("[Setup] Pollers started");
  });

  afterAll(async () => {
    // Stop pollers
    stopAllPollers();
    stopSettlementPoller();
    console.log("[Teardown] Pollers stopped");

    // Database is NOT torn down - data persists in ./test-data/pglite/
    console.log("[Teardown] Database retained at ./test-data/pglite/ for inspection");
  });

  describe("ETH -> USDC (EthFlow)", () => {
    it("swaps native ETH for USDC via EthFlow contract", async () => {
      const sellAmount = TEST_AMOUNTS.ETH.toString();

      // 1. Get quote
      console.log("[ETH->USDC] Getting quote...");
      const quoteResponse = await request(app, "/quote", {
        method: "POST",
        body: {
          chainId: 8453, // Base
          sellToken: TOKENS.ETH,
          buyToken: TOKENS.USDC,
          sellAmount,
        },
      });
      expect(quoteResponse.status).toBe(200);
      const quote = (await quoteResponse.json()) as QuoteResponse;
      console.log(`[ETH->USDC] Quote: ${formatUnits(BigInt(quote.buyAmountEstimate), 6)} USDC`);

      // 2. Create swap
      console.log("[ETH->USDC] Creating swap...");
      const createResponse = await request(app, "/swap", {
        method: "POST",
        body: {
          chainId: 8453,
          sellToken: TOKENS.ETH,
          buyToken: TOKENS.USDC,
          sellAmount,
          recipientAddress: testAccount,
          refundAddress: testAccount,
        },
      });
      expect(createResponse.status).toBe(200);
      const swap = (await createResponse.json()) as CreateSwapResponse;
      console.log(`[ETH->USDC] Swap created: ${swap.swapId}`);
      console.log(`[ETH->USDC] Deposit address: ${swap.depositAddress}`);

      // 3. Record initial USDC balance
      const initialUsdcBalance = await getTokenBalance(publicClient, TOKEN_ADDRESSES.USDC, testAccount);
      console.log(`[ETH->USDC] Initial USDC balance: ${formatUnits(initialUsdcBalance, 6)}`);

      // 4. Send ETH to deposit address
      console.log("[ETH->USDC] Sending ETH to deposit address...");
      const txHash = await sendTokens(
        walletClient,
        publicClient,
        TOKEN_ADDRESSES.ETH,
        swap.depositAddress as Address,
        BigInt(sellAmount)
      );
      console.log(`[ETH->USDC] Deposit tx: ${txHash}`);

      // 5. Poll until complete
      console.log("[ETH->USDC] Polling for completion...");
      const finalStatus = await pollUntilComplete(app, swap.swapId);
      expect(finalStatus.status).toBe("complete");
      expect(finalStatus.settlementTxHash).toBeDefined();
      console.log(`[ETH->USDC] Settlement tx: ${finalStatus.settlementTxHash}`);

      // 6. Verify USDC balance increased
      const finalUsdcBalance = await getTokenBalance(publicClient, TOKEN_ADDRESSES.USDC, testAccount);
      console.log(`[ETH->USDC] Final USDC balance: ${formatUnits(finalUsdcBalance, 6)}`);
      expect(finalUsdcBalance).toBeGreaterThan(initialUsdcBalance);

      const received = finalUsdcBalance - initialUsdcBalance;
      console.log(`[ETH->USDC] Received: ${formatUnits(received, 6)} USDC`);
    }, 360_000); // 6 minute timeout
  });

  describe("USDC -> ETH (Permit Flow)", () => {
    it("swaps USDC for ETH via permit", async () => {
      const sellAmount = TEST_AMOUNTS.USDC.toString();

      // 1. Get quote
      console.log("[USDC->ETH] Getting quote...");
      const quoteResponse = await request(app, "/quote", {
        method: "POST",
        body: {
          chainId: 8453,
          sellToken: TOKENS.USDC,
          buyToken: TOKENS.ETH,
          sellAmount,
        },
      });
      expect(quoteResponse.status).toBe(200);
      const quote = (await quoteResponse.json()) as QuoteResponse;
      console.log(`[USDC->ETH] Quote: ${formatUnits(BigInt(quote.buyAmountEstimate), 18)} ETH`);

      // 2. Create swap
      console.log("[USDC->ETH] Creating swap...");
      const createResponse = await request(app, "/swap", {
        method: "POST",
        body: {
          chainId: 8453,
          sellToken: TOKENS.USDC,
          buyToken: TOKENS.ETH,
          sellAmount,
          recipientAddress: testAccount,
          refundAddress: testAccount,
        },
      });
      expect(createResponse.status).toBe(200);
      const swap = (await createResponse.json()) as CreateSwapResponse;
      console.log(`[USDC->ETH] Swap created: ${swap.swapId}`);
      console.log(`[USDC->ETH] Deposit address: ${swap.depositAddress}`);

      // 3. Record initial ETH balance
      const initialEthBalance = await getTokenBalance(publicClient, TOKEN_ADDRESSES.ETH, testAccount);
      console.log(`[USDC->ETH] Initial ETH balance: ${formatUnits(initialEthBalance, 18)}`);

      // 4. Send USDC to deposit address
      console.log("[USDC->ETH] Sending USDC to deposit address...");
      const txHash = await sendTokens(
        walletClient,
        publicClient,
        TOKEN_ADDRESSES.USDC,
        swap.depositAddress as Address,
        BigInt(sellAmount)
      );
      console.log(`[USDC->ETH] Deposit tx: ${txHash}`);

      // 5. Poll until complete
      console.log("[USDC->ETH] Polling for completion...");
      const finalStatus = await pollUntilComplete(app, swap.swapId);
      expect(finalStatus.status).toBe("complete");
      expect(finalStatus.settlementTxHash).toBeDefined();
      console.log(`[USDC->ETH] Settlement tx: ${finalStatus.settlementTxHash}`);

      // 6. Log final balances (swap completed successfully - gas costs may exceed small swap amounts)
      const finalEthBalance = await getTokenBalance(publicClient, TOKEN_ADDRESSES.ETH, testAccount);
      console.log(`[USDC->ETH] Final ETH balance: ${formatUnits(finalEthBalance, 18)}`);

      // Note: For small swaps, the gas cost of depositing USDC may exceed the ETH received
      // The important thing is that the swap completed and settlement occurred
      const netChange = finalEthBalance - initialEthBalance;
      console.log(`[USDC->ETH] Net ETH change: ${formatUnits(netChange, 18)} ETH (includes gas costs)`);
    }, 360_000);
  });

  // USDT test commented out - legacy flow not implemented, just wastes funds
  // describe("USDT -> ETH (Legacy Flow)", () => {
  //   it("swaps USDT for ETH (expected to fail - legacy flow not implemented)", async () => {
  //     const sellAmount = TEST_AMOUNTS.USDT.toString();
  //
  //     // 1. Get quote
  //     console.log("[USDT->ETH] Getting quote...");
  //     const quoteResponse = await request(app, "/quote", {
  //       method: "POST",
  //       body: {
  //         chainId: 8453,
  //         sellToken: TOKENS.USDT,
  //         buyToken: TOKENS.ETH,
  //         sellAmount,
  //       },
  //     });
  //     expect(quoteResponse.status).toBe(200);
  //     const quote = (await quoteResponse.json()) as QuoteResponse;
  //     console.log(`[USDT->ETH] Quote: ${formatUnits(BigInt(quote.buyAmountEstimate), 18)} ETH`);
  //
  //     // 2. Create swap
  //     console.log("[USDT->ETH] Creating swap...");
  //     const createResponse = await request(app, "/swap", {
  //       method: "POST",
  //       body: {
  //         chainId: 8453,
  //         sellToken: TOKENS.USDT,
  //         buyToken: TOKENS.ETH,
  //         sellAmount,
  //         recipientAddress: testAccount,
  //         refundAddress: testAccount,
  //       },
  //     });
  //     expect(createResponse.status).toBe(200);
  //     const swap = (await createResponse.json()) as CreateSwapResponse;
  //     console.log(`[USDT->ETH] Swap created: ${swap.swapId}`);
  //     console.log(`[USDT->ETH] Deposit address: ${swap.depositAddress}`);
  //
  //     // 3. Send USDT to deposit address
  //     console.log("[USDT->ETH] Sending USDT to deposit address...");
  //     const txHash = await sendTokens(
  //       walletClient,
  //       publicClient,
  //       TOKENS.USDT,
  //       swap.depositAddress as Address,
  //       BigInt(sellAmount)
  //     );
  //     console.log(`[USDT->ETH] Deposit tx: ${txHash}`);
  //
  //     // 4. Poll - expect failure since legacy flow is not implemented
  //     // The permit flow will try first, and if USDT doesn't support permits,
  //     // it will fall back to legacy which throws UnsupportedTokenError
  //     console.log("[USDT->ETH] Polling for status (expecting failure)...");
  //
  //     // Give it some time for the poller to pick up and process
  //     await new Promise((resolve) => setTimeout(resolve, 15_000));
  //
  //     const statusResponse = await request(app, `/swap/${swap.swapId}`);
  //     const status = (await statusResponse.json()) as SwapStatusResponse;
  //
  //     console.log(`[USDT->ETH] Final status: ${status.status}`);
  //
  //     // This test documents expected behavior - USDT swap should fail
  //     // because legacy flow is not implemented
  //     // If USDT supports permits on Base, this will actually succeed!
  //     if (status.status === "complete") {
  //       console.log("[USDT->ETH] Unexpected success! USDT may support permits on Base.");
  //     } else {
  //       console.log("[USDT->ETH] Failed as expected - legacy flow not implemented");
  //       expect(status.status).toBe("failed");
  //     }
  //   }, 120_000);
  // });
});
