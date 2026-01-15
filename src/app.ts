import { Elysia } from "elysia";
import { healthRoutes } from "./routes/health";
import { quoteRoutes } from "./routes/quote";
import { swapRoutes } from "./routes/swap";
import { metricsRoutes } from "./routes/metrics";
import { recordHttpRequest } from "./services/metrics";

/**
 * Create the Elysia app instance.
 * Separated from index.ts for testability.
 */
export function createApp() {
  return new Elysia()
    // Track request start time
    .onRequest(({ store }) => {
      (store as Record<string, number>).startTime = performance.now();
    })
    // Record metrics after response
    .onAfterResponse(({ request, set, store }) => {
      const startTime = (store as Record<string, number>).startTime;
      if (startTime) {
        const duration = performance.now() - startTime;
        const url = new URL(request.url);
        const path = url.pathname;
        // Skip /metrics endpoint to avoid noise
        if (path !== "/metrics") {
          recordHttpRequest(request.method, path, set.status as number || 200, duration);
        }
      }
    })
    .onError(({ error, code, set, request, store }) => {
      // Record error metrics
      const startTime = (store as Record<string, number>).startTime;
      if (startTime) {
        const duration = performance.now() - startTime;
        const url = new URL(request.url);
        const path = url.pathname;
        if (path !== "/metrics") {
          const status = set.status as number || 500;
          recordHttpRequest(request.method, path, status, duration);
        }
      }

      // Handle specific error codes
      if (code === "NOT_FOUND") {
        set.status = 404;
        return { error: "Not found" };
      }

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
    .use(metricsRoutes)
    .use(healthRoutes)
    .use(quoteRoutes)
    .use(swapRoutes);
}

export type App = ReturnType<typeof createApp>;
