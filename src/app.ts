import { Elysia } from "elysia";
import { healthRoutes } from "./routes/health";
import { quoteRoutes } from "./routes/quote";
import { swapRoutes } from "./routes/swap";
import { metricsRoutes } from "./routes/metrics";

/**
 * Create the Elysia app instance.
 * Separated from index.ts for testability.
 */
export function createApp() {
  return new Elysia()
    .onError(({ error, code, set }) => {
      // Let validation errors pass through with their proper status
      if (code === "VALIDATION") {
        set.status = 422;
        return {
          error: "Validation error",
          details: error.message,
        };
      }

      console.error("[Server] Unhandled error:", error);
      set.status = 500;
      return { error: "Internal server error" };
    })
    // Metrics first so middleware applies to all routes
    .use(metricsRoutes)
    .use(healthRoutes)
    .use(quoteRoutes)
    .use(swapRoutes);
}

export type App = ReturnType<typeof createApp>;
