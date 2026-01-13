import { Elysia } from "elysia";
import { registry, recordHttpRequest, normalizePath } from "../services/metrics";

/**
 * Metrics routes and middleware for Prometheus
 */
export const metricsRoutes = new Elysia()
  // Middleware to track HTTP requests (runs for all routes)
  .onBeforeHandle(({ request, store }) => {
    // Store start time for duration calculation
    (store as Record<string, number>).startTime = performance.now();
  })
  .onAfterHandle(({ request, set, store }) => {
    const startTime = (store as Record<string, number>).startTime;
    if (startTime) {
      const duration = performance.now() - startTime;
      const url = new URL(request.url);
      const path = url.pathname;

      // Don't record metrics endpoint itself to avoid recursion
      if (path !== "/metrics") {
        recordHttpRequest(request.method, path, set.status as number || 200, duration);
      }
    }
  })
  .onError(({ request, set, store, error }) => {
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
  })
  // Prometheus scrape endpoint
  .get("/metrics", async ({ set }) => {
    set.headers["content-type"] = registry.contentType;
    return await registry.metrics();
  });
