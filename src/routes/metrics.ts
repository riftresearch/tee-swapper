import { Elysia } from "elysia";
import { registry } from "../services/metrics";

/**
 * Prometheus scrape endpoint
 */
export const metricsRoutes = new Elysia()
  .get("/metrics", async ({ set }) => {
    set.headers["content-type"] = registry.contentType;
    return await registry.metrics();
  });
