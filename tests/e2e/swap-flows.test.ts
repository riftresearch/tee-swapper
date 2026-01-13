/**
 * End-to-end integration tests for swap flows on Base chain.
 *
 * These tests use real blockchain transactions and require:
 * - TEST_PRIVATE_KEY in .env (funded account with CBBTC on Base)
 * - BASE_RPC_URL in .env (or uses default public RPC)
 *
 * All swaps sell CBBTC using the EIP-2612 permit flow (gasless approvals).
 * CBBTC is the only supported input token.
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

// Base chain token addresses for ERC20 tokens
const TOKEN_ADDRESSES = {
  CBBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as const,
  WETH: "0x4200000000000000000000000000000000000006" as const,
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const,
} as const;

// Token objects for API requests (buyToken only - sellToken is always CBBTC)
const TOKENS = {
  ETH: { type: "ether" as const },  // Native ETH (not WETH)
  WETH: { type: "erc20" as const, address: TOKEN_ADDRESSES.WETH },
  USDC: { type: "erc20" as const, address: TOKEN_ADDRESSES.USDC },
} as const;

// Test amounts
const TEST_AMOUNTS = {
  CBBTC_QUOTE: parseUnits("0.0002", 8),  // 0.0002 CBBTC - amount used for quote
  CBBTC_DEPOSIT: parseUnits("0.0001", 8), // 0.0001 CBBTC - amount actually deposited (different from quote)
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

    // Check CBBTC balance
    const cbbtcBalance = await getTokenBalance(publicClient, TOKEN_ADDRESSES.CBBTC, testAccount);
    console.log(`[Setup] CBBTC balance: ${formatUnits(cbbtcBalance, 8)} CBBTC`);

    // Validate sufficient balance
    if (cbbtcBalance < TEST_AMOUNTS.CBBTC_DEPOSIT) {
      throw new Error("Insufficient CBBTC balance for tests");
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

  describe("CBBTC -> USDC (Permit Flow)", () => {
    it("swaps CBBTC for USDC via EIP-2612 permit", async () => {
      // Quote for a LARGER amount than we'll actually deposit
      // This tests that the swap executes for the deposited amount, not the quoted amount
      const quoteAmount = TEST_AMOUNTS.CBBTC_QUOTE.toString();
      const depositAmount = TEST_AMOUNTS.CBBTC_DEPOSIT;

      // 1. Get quote for the larger amount (informational only)
      console.log(`[CBBTC->USDC] Getting quote for ${formatUnits(TEST_AMOUNTS.CBBTC_QUOTE, 8)} CBBTC...`);
      const quoteResponse = await request(app, "/quote", {
        method: "POST",
        body: {
          chainId: 8453,
          buyToken: TOKENS.USDC,
          sellAmount: quoteAmount,
        },
      });
      expect(quoteResponse.status).toBe(200);
      const quote = (await quoteResponse.json()) as QuoteResponse;
      console.log(`[CBBTC->USDC] Quote: ${formatUnits(BigInt(quote.buyAmountEstimate), 6)} USDC (for ${formatUnits(TEST_AMOUNTS.CBBTC_QUOTE, 8)} CBBTC)`);

      // 2. Create swap (amount will be determined by actual deposit, not quote)
      console.log("[CBBTC->USDC] Creating swap...");
      const createResponse = await request(app, "/swap", {
        method: "POST",
        body: {
          chainId: 8453,
          buyToken: TOKENS.USDC,
          recipientAddress: testAccount,
          refundAddress: testAccount,
        },
      });
      expect(createResponse.status).toBe(200);
      const swap = (await createResponse.json()) as CreateSwapResponse;
      console.log(`[CBBTC->USDC] Swap created: ${swap.swapId}`);
      console.log(`[CBBTC->USDC] Vault address: ${swap.vaultAddress}`);

      // 3. Record initial USDC balance
      const initialUsdcBalance = await getTokenBalance(publicClient, TOKEN_ADDRESSES.USDC, testAccount);
      console.log(`[CBBTC->USDC] Initial USDC balance: ${formatUnits(initialUsdcBalance, 6)}`);

      // 4. Send SMALLER amount than quoted - swap should still work for deposited amount
      console.log(`[CBBTC->USDC] Sending ${formatUnits(depositAmount, 8)} CBBTC to vault (less than quoted)...`);
      const txHash = await sendTokens(
        walletClient,
        publicClient,
        TOKEN_ADDRESSES.CBBTC,
        swap.vaultAddress as Address,
        depositAmount
      );
      console.log(`[CBBTC->USDC] Deposit tx: ${txHash}`);

      // 5. Poll until complete
      console.log("[CBBTC->USDC] Polling for completion...");
      const finalStatus = await pollUntilComplete(app, swap.swapId);
      expect(finalStatus.status).toBe("complete");
      expect(finalStatus.settlementTxHash).toBeDefined();
      console.log(`[CBBTC->USDC] Settlement tx: ${finalStatus.settlementTxHash}`);

      // 6. Verify USDC balance increased
      const finalUsdcBalance = await getTokenBalance(publicClient, TOKEN_ADDRESSES.USDC, testAccount);
      console.log(`[CBBTC->USDC] Final USDC balance: ${formatUnits(finalUsdcBalance, 6)}`);
      expect(finalUsdcBalance).toBeGreaterThan(initialUsdcBalance);

      const received = finalUsdcBalance - initialUsdcBalance;
      console.log(`[CBBTC->USDC] Received: ${formatUnits(received, 6)} USDC`);
    }, 360_000);
  });

  describe("CBBTC -> Native ETH (Permit Flow)", () => {
    it("swaps CBBTC for native ETH via EIP-2612 permit", async () => {
      // Quote for a LARGER amount than we'll actually deposit
      const quoteAmount = TEST_AMOUNTS.CBBTC_QUOTE.toString();
      const depositAmount = TEST_AMOUNTS.CBBTC_DEPOSIT;

      // 1. Get quote for the larger amount (informational only)
      console.log(`[CBBTC->ETH] Getting quote for ${formatUnits(TEST_AMOUNTS.CBBTC_QUOTE, 8)} CBBTC...`);
      const quoteResponse = await request(app, "/quote", {
        method: "POST",
        body: {
          chainId: 8453,
          buyToken: TOKENS.ETH,
          sellAmount: quoteAmount,
        },
      });
      expect(quoteResponse.status).toBe(200);
      const quote = (await quoteResponse.json()) as QuoteResponse;
      console.log(`[CBBTC->ETH] Quote: ${formatUnits(BigInt(quote.buyAmountEstimate), 18)} ETH (for ${formatUnits(TEST_AMOUNTS.CBBTC_QUOTE, 8)} CBBTC)`);

      // 2. Create swap (amount will be determined by actual deposit, not quote)
      console.log("[CBBTC->ETH] Creating swap...");
      const createResponse = await request(app, "/swap", {
        method: "POST",
        body: {
          chainId: 8453,
          buyToken: TOKENS.ETH,
          recipientAddress: testAccount,
          refundAddress: testAccount,
        },
      });
      expect(createResponse.status).toBe(200);
      const swap = (await createResponse.json()) as CreateSwapResponse;
      console.log(`[CBBTC->ETH] Swap created: ${swap.swapId}`);
      console.log(`[CBBTC->ETH] Vault address: ${swap.vaultAddress}`);

      // 3. Record initial ETH balance (native ETH, not WETH)
      const initialEthBalance: bigint = await publicClient.getBalance({ address: testAccount });
      console.log(`[CBBTC->ETH] Initial ETH balance: ${formatUnits(initialEthBalance, 18)}`);

      // 4. Send SMALLER amount than quoted - swap should still work for deposited amount
      console.log(`[CBBTC->ETH] Sending ${formatUnits(depositAmount, 8)} CBBTC to vault (less than quoted)...`);
      const txHash = await sendTokens(
        walletClient,
        publicClient,
        TOKEN_ADDRESSES.CBBTC,
        swap.vaultAddress as Address,
        depositAmount
      );
      console.log(`[CBBTC->ETH] Deposit tx: ${txHash}`);

      // 5. Poll until complete
      console.log("[CBBTC->ETH] Polling for completion...");
      const finalStatus = await pollUntilComplete(app, swap.swapId);
      expect(finalStatus.status).toBe("complete");
      expect(finalStatus.settlementTxHash).toBeDefined();
      console.log(`[CBBTC->ETH] Settlement tx: ${finalStatus.settlementTxHash}`);

      // 6. Verify ETH balance increased (native ETH, not WETH)
      const finalEthBalance: bigint = await publicClient.getBalance({ address: testAccount });
      console.log(`[CBBTC->ETH] Final ETH balance: ${formatUnits(finalEthBalance, 18)}`);
      expect(finalEthBalance).toBeGreaterThan(initialEthBalance);

      const received = finalEthBalance - initialEthBalance;
      console.log(`[CBBTC->ETH] Received: ${formatUnits(received, 18)} ETH (native)`);
    }, 360_000);
  });
});
