import { createApp } from "./app";
import { runMigrations } from "./db/client";
import { startAllPollers, stopAllPollers } from "./services/poller";
import { startSettlementPoller, stopSettlementPoller } from "./services/settlement";
import { startMetricsPush, stopMetricsPush } from "./services/metrics";
import { initCowSdkAdapter } from "./services/cowswap-adapter";
import { initKeyDerivation } from "./services/key-derivation";

// Initialize the COW SDK adapter before any COW SDK operations
initCowSdkAdapter();

// Initialize the key derivation service (loads server key from file)
initKeyDerivation();

const PORT = process.env.PORT || 3000;

// Run migrations before starting the app
await runMigrations();

// Create and start the app
const app = createApp().listen(PORT);

console.log(`🦊 TEE Swapper API running at http://localhost:${PORT}`);

// Start balance pollers for all chains
startAllPollers();

// Start settlement poller for order tracking
startSettlementPoller();

// Start metrics push to Grafana Cloud (if configured)
startMetricsPush();

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[Server] Shutting down...");
  stopAllPollers();
  stopSettlementPoller();
  stopMetricsPush();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n[Server] Shutting down...");
  stopAllPollers();
  stopSettlementPoller();
  stopMetricsPush();
  process.exit(0);
});

export type App = typeof app;


