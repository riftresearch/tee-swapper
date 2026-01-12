import { createApp } from "./app";
import { startAllPollers, stopAllPollers } from "./services/poller";
import { startSettlementPoller, stopSettlementPoller } from "./services/settlement";
import { initCowSdkAdapter } from "./services/cowswap-adapter";

// Initialize the COW SDK adapter before any COW SDK operations
initCowSdkAdapter();

const PORT = process.env.PORT || 3000;

// Create and start the app
const app = createApp().listen(PORT);

console.log(`🦊 TEE Swapper API running at http://localhost:${PORT}`);

// Start balance pollers for all chains
startAllPollers();

// Start settlement poller for order tracking
startSettlementPoller();

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[Server] Shutting down...");
  stopAllPollers();
  stopSettlementPoller();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n[Server] Shutting down...");
  stopAllPollers();
  stopSettlementPoller();
  process.exit(0);
});

export type App = typeof app;


