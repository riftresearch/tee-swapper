/**
 * Benchmark test to find the maximum number of addresses
 * we can query via multicall in a single RPC call.
 */

import { describe, it, expect } from "bun:test";
import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
  erc20Abi,
} from "viem";
import { base } from "viem/chains";

// CBBTC on Base
const CBBTC_ADDRESS = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as const;

/**
 * Generate random Ethereum addresses
 */
function generateRandomAddresses(count: number): Address[] {
  const addresses: Address[] = [];
  for (let i = 0; i < count; i++) {
    // Generate 20 random bytes as hex
    const randomBytes = new Uint8Array(20);
    crypto.getRandomValues(randomBytes);
    const hex = Array.from(randomBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    addresses.push(`0x${hex}` as Address);
  }
  return addresses;
}

/**
 * Try to query balances for N addresses via multicall
 * Returns true if successful, false if failed
 */
async function tryMulticall(
  client: PublicClient,
  addresses: Address[]
): Promise<{ success: boolean; timeMs: number; error?: string }> {
  const contracts = addresses.map((address) => ({
    address: CBBTC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf" as const,
    args: [address] as const,
  }));

  const startTime = performance.now();

  try {
    const results = await client.multicall({
      contracts,
      allowFailure: true,
    });

    const timeMs = performance.now() - startTime;

    // Check that we got results back
    if (results.length !== addresses.length) {
      return { success: false, timeMs, error: "Result count mismatch" };
    }

    return { success: true, timeMs };
  } catch (error) {
    const timeMs = performance.now() - startTime;
    return {
      success: false,
      timeMs,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Skipped by default - run with: bun test tests/benchmarks/multicall-limit.test.ts --todo
describe.skip("Multicall Limit Benchmark", () => {
  const rpcUrl = process.env.BASE_RPC_URL || "https://base.drpc.org";
  const client = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  }) as PublicClient;

  it("finds maximum multicall batch size via binary search", async () => {
    console.log("\n📊 Multicall Limit Benchmark");
    console.log(`   RPC: ${rpcUrl}\n`);

    // Binary search for the limit
    let low = 100;
    let high = 10000;
    let lastSuccess = 0;
    let lastSuccessTime = 0;

    // First, verify small batch works
    const smallTest = await tryMulticall(client, generateRandomAddresses(100));
    if (!smallTest.success) {
      throw new Error(`Even 100 addresses failed: ${smallTest.error}`);
    }
    console.log(`   ✅ 100 addresses: ${smallTest.timeMs.toFixed(0)}ms`);

    // Binary search
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const addresses = generateRandomAddresses(mid);

      console.log(`   🔍 Testing ${mid} addresses...`);
      const result = await tryMulticall(client, addresses);

      if (result.success) {
        console.log(`   ✅ ${mid} addresses: ${result.timeMs.toFixed(0)}ms`);
        lastSuccess = mid;
        lastSuccessTime = result.timeMs;
        low = mid + 1;
      } else {
        console.log(`   ❌ ${mid} addresses failed: ${result.error}`);
        high = mid - 1;
      }

      // Small delay to avoid rate limiting
      await new Promise((r) => setTimeout(r, 500));
    }

    console.log("\n📈 Results:");
    console.log(`   Maximum successful batch: ${lastSuccess} addresses`);
    console.log(`   Time for max batch: ${lastSuccessTime.toFixed(0)}ms`);
    console.log(`   Recommended safe limit: ${Math.floor(lastSuccess * 0.8)} addresses`);

    // Test a few specific sizes for timing data
    console.log("\n⏱️  Timing at various sizes:");
    const testSizes = [100, 250, 500, 750, 1000].filter((s) => s <= lastSuccess);

    for (const size of testSizes) {
      const addresses = generateRandomAddresses(size);
      const result = await tryMulticall(client, addresses);
      if (result.success) {
        const perAddress = result.timeMs / size;
        console.log(
          `   ${size.toString().padStart(5)} addresses: ${result.timeMs.toFixed(0).padStart(5)}ms (${perAddress.toFixed(2)}ms/addr)`
        );
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    expect(lastSuccess).toBeGreaterThan(100);
  }, 120_000); // 2 minute timeout
});
