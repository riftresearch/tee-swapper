import {
  Registry,
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
} from "prom-client";
import { sql } from "drizzle-orm";
import { getDb } from "../db/client";

// Metric type constants (prom-client doesn't export the MetricType enum at runtime)
const METRIC_TYPE_COUNTER = "counter";
const METRIC_TYPE_GAUGE = "gauge";
const METRIC_TYPE_HISTOGRAM = "histogram";

// Create a custom registry
export const registry = new Registry();

// Collect default Node.js metrics (memory, CPU, event loop, etc.)
collectDefaultMetrics({ register: registry });

// =============================================================================
// Grafana Cloud OTLP Configuration
// =============================================================================

interface GrafanaCloudConfig {
  host: string;       // e.g., https://otlp-gateway-prod-us-east-3.grafana.net
  instanceId: string; // Grafana Cloud instance ID
  apiKey: string;     // Grafana Cloud API key
}

let grafanaCloudConfig: GrafanaCloudConfig | null = null;
let pushInterval: ReturnType<typeof setInterval> | null = null;

// Default push interval: 15 seconds
const METRICS_PUSH_INTERVAL_MS = 15_000;

// =============================================================================
// HTTP Metrics
// =============================================================================

export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "path", "status"] as const,
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "path", "status"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// =============================================================================
// Swap Lifecycle Metrics
// =============================================================================

export const swapsActive = new Gauge({
  name: "swaps_active",
  help: "Number of active swaps by status and chain",
  labelNames: ["status", "chain_id"] as const,
  registers: [registry],
});

export const swapsCompletedTotal = new Counter({
  name: "swaps_completed_total",
  help: "Total number of successfully completed swaps",
  labelNames: ["chain_id"] as const,
  registers: [registry],
});

export const swapDurationSeconds = new Histogram({
  name: "swap_duration_seconds",
  help: "Duration from deposit detection to swap completion in seconds",
  labelNames: ["chain_id"] as const,
  buckets: [10, 30, 60, 120, 300, 600, 1800, 3600], // 10s to 1h
  registers: [registry],
});

// =============================================================================
// External API Metrics
// =============================================================================

export const cowswapApiErrorsTotal = new Counter({
  name: "cowswap_api_errors_total",
  help: "Total number of COWSwap API errors",
  labelNames: ["chain_id", "endpoint"] as const,
  registers: [registry],
});

// =============================================================================
// Database Metrics
// =============================================================================

export const databaseSizeBytes = new Gauge({
  name: "database_size_bytes",
  help: "Size of the PostgreSQL database in bytes",
  registers: [registry],
});

export const swapsTableRowCount = new Gauge({
  name: "swaps_table_row_count",
  help: "Total number of rows in the swaps table",
  registers: [registry],
});

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Normalize path for metrics labels
 * Replaces dynamic segments like /swap/abc123 with /swap/:id
 */
export function normalizePath(path: string): string {
  // Replace UUID-like segments (swap IDs)
  return path
    .replace(/\/swap\/[a-f0-9-]{36}/i, "/swap/:id")
    .replace(/\/swap\/[a-zA-Z0-9_-]+$/, "/swap/:id");
}

/**
 * Record an HTTP request
 */
export function recordHttpRequest(
  method: string,
  path: string,
  status: number,
  durationMs: number
): void {
  const normalizedPath = normalizePath(path);
  const statusStr = status.toString();

  httpRequestsTotal.inc({ method, path: normalizedPath, status: statusStr });
  httpRequestDuration.observe(
    { method, path: normalizedPath, status: statusStr },
    durationMs / 1000
  );
}

/**
 * Record a completed swap
 */
export function recordSwapCompleted(
  chainId: number,
  durationSeconds: number
): void {
  swapsCompletedTotal.inc({ chain_id: chainId.toString() });
  swapDurationSeconds.observe({ chain_id: chainId.toString() }, durationSeconds);
}

/**
 * Record a COWSwap API error
 */
export function recordCowswapError(chainId: number, endpoint: string): void {
  cowswapApiErrorsTotal.inc({
    chain_id: chainId.toString(),
    endpoint,
  });
}

/**
 * Update active swap counts (call periodically from settlement poller)
 */
export function updateActiveSwapCounts(
  counts: Array<{ chainId: number; status: string; count: number }>
): void {
  // Reset all to 0 first (handles statuses that no longer have any swaps)
  swapsActive.reset();

  for (const { chainId, status, count } of counts) {
    swapsActive.set(
      { chain_id: chainId.toString(), status },
      count
    );
  }
}

/**
 * Update database metrics (size and row counts)
 * Queries PostgreSQL for current database stats
 */
export async function updateDatabaseMetrics(): Promise<void> {
  try {
    const db = getDb();

    // Query database size and swap count in parallel
    const [sizeResult, countResult] = await Promise.all([
      db.execute(sql`SELECT pg_database_size(current_database()) as size`),
      db.execute(sql`SELECT COUNT(*) as count FROM swaps`),
    ]);

    // Update database size
    if (sizeResult.length > 0 && sizeResult[0] && typeof sizeResult[0].size === 'string') {
      const sizeBytes = parseInt(sizeResult[0].size, 10);
      if (!isNaN(sizeBytes)) {
        databaseSizeBytes.set(sizeBytes);
      }
    }

    // Update swaps row count
    if (countResult.length > 0 && countResult[0] && typeof countResult[0].count === 'string') {
      const count = parseInt(countResult[0].count, 10);
      if (!isNaN(count)) {
        swapsTableRowCount.set(count);
      }
    }
  } catch (error) {
    // Log but don't throw - these are nice-to-have metrics
    console.error("[Metrics] Failed to update database metrics:", error);
  }
}

// =============================================================================
// Grafana Cloud OTLP Push
// =============================================================================

/**
 * OTLP metric types
 */
interface OtlpAttribute {
  key: string;
  value: { stringValue: string } | { intValue: number };
}

interface OtlpDataPoint {
  timeUnixNano: string;
  asDouble?: number;
  asInt?: number;
  attributes: OtlpAttribute[];
}

interface OtlpMetric {
  name: string;
  unit: string;
  gauge?: { dataPoints: OtlpDataPoint[] };
  sum?: { dataPoints: OtlpDataPoint[]; aggregationTemporality: number; isMonotonic: boolean };
}

interface OtlpPayload {
  resourceMetrics: Array<{
    resource: { attributes: OtlpAttribute[] };
    scopeMetrics: Array<{
      scope: { name: string };
      metrics: OtlpMetric[];
    }>;
  }>;
}

/**
 * Convert prom-client metrics to OTLP format
 */
async function buildOtlpPayload(): Promise<OtlpPayload> {
  const promMetrics = await registry.getMetricsAsJSON();
  const nowNs = BigInt(Date.now()) * BigInt(1_000_000);
  const metrics: OtlpMetric[] = [];

  for (const metric of promMetrics) {
    const metricName = metric.name;
    const metricType = metric.type as unknown as string;

    if (metricType === METRIC_TYPE_GAUGE) {
      // Gauge metrics
      const dataPoints: OtlpDataPoint[] = [];
      for (const value of metric.values) {
        const attributes: OtlpAttribute[] = [];
        if (value.labels) {
          for (const [key, val] of Object.entries(value.labels)) {
            attributes.push({ key, value: { stringValue: String(val) } });
          }
        }
        dataPoints.push({
          timeUnixNano: nowNs.toString(),
          asDouble: value.value as number,
          attributes,
        });
      }
      if (dataPoints.length > 0) {
        metrics.push({ name: metricName, unit: "1", gauge: { dataPoints } });
      }
    } else if (metricType === METRIC_TYPE_COUNTER) {
      // Counter metrics (as monotonic sum)
      const dataPoints: OtlpDataPoint[] = [];
      for (const value of metric.values) {
        const attributes: OtlpAttribute[] = [];
        if (value.labels) {
          for (const [key, val] of Object.entries(value.labels)) {
            attributes.push({ key, value: { stringValue: String(val) } });
          }
        }
        dataPoints.push({
          timeUnixNano: nowNs.toString(),
          asDouble: value.value as number,
          attributes,
        });
      }
      if (dataPoints.length > 0) {
        metrics.push({
          name: metricName,
          unit: "1",
          sum: { dataPoints, aggregationTemporality: 2, isMonotonic: true },
        });
      }
    } else if (metricType === METRIC_TYPE_HISTOGRAM) {
      // Histogram - emit as separate gauge metrics for sum, count, buckets
      for (const value of metric.values) {
        const attributes: OtlpAttribute[] = [];
        if (value.labels) {
          for (const [key, val] of Object.entries(value.labels)) {
            attributes.push({ key, value: { stringValue: String(val) } });
          }
        }
        const valueName = (value as { metricName?: string }).metricName;
        if (valueName) {
          metrics.push({
            name: valueName,
            unit: "1",
            gauge: {
              dataPoints: [{
                timeUnixNano: nowNs.toString(),
                asDouble: value.value as number,
                attributes,
              }],
            },
          });
        }
      }
    }
  }

  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "tee-swapper" } },
          ],
        },
        scopeMetrics: [
          {
            scope: { name: "tee-swapper-metrics" },
            metrics,
          },
        ],
      },
    ],
  };
}

/**
 * Push metrics to Grafana Cloud via OTLP
 */
async function pushMetricsToGrafanaCloud(): Promise<void> {
  if (!grafanaCloudConfig) {
    return;
  }

  try {
    // Update database metrics before pushing
    await updateDatabaseMetrics();

    const payload = await buildOtlpPayload();
    const metricCount = payload.resourceMetrics[0]?.scopeMetrics[0]?.metrics.length ?? 0;

    if (metricCount === 0) {
      return;
    }

    const authPair = `${grafanaCloudConfig.instanceId}:${grafanaCloudConfig.apiKey}`;
    const encoded = Buffer.from(authPair).toString("base64");

    const url = `${grafanaCloudConfig.host}/otlp/v1/metrics`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${encoded}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[Metrics] Push failed (${response.status}): ${body}`);
    }
  } catch (error) {
    console.error("[Metrics] Failed to push to Grafana Cloud:", error);
  }
}

/**
 * Start pushing metrics to Grafana Cloud via OTLP
 *
 * Reads configuration from environment variables:
 * - GRAFANA_CLOUD_URL: OTLP gateway host (e.g., https://otlp-gateway-prod-us-east-3.grafana.net)
 * - GRAFANA_CLOUD_USERNAME: Grafana Cloud instance ID
 * - GRAFANA_CLOUD_API_KEY: Grafana Cloud API key
 */
export function startMetricsPush(): void {
  const host = process.env.GRAFANA_CLOUD_URL;
  const instanceId = process.env.GRAFANA_CLOUD_USERNAME;
  const apiKey = process.env.GRAFANA_CLOUD_API_KEY;

  if (!host || !instanceId || !apiKey) {
    console.log(
      "[Metrics] Grafana Cloud not configured. Set GRAFANA_CLOUD_URL, GRAFANA_CLOUD_USERNAME, and GRAFANA_CLOUD_API_KEY to enable remote push."
    );
    return;
  }

  grafanaCloudConfig = { host, instanceId, apiKey };

  console.log(
    `[Metrics] Starting Grafana Cloud push (interval: ${METRICS_PUSH_INTERVAL_MS}ms)`
  );

  // Push immediately
  pushMetricsToGrafanaCloud().catch((err) =>
    console.error("[Metrics] Initial push error:", err)
  );

  // Then push on interval
  pushInterval = setInterval(() => {
    pushMetricsToGrafanaCloud().catch((err) =>
      console.error("[Metrics] Push error:", err)
    );
  }, METRICS_PUSH_INTERVAL_MS);
}

/**
 * Stop pushing metrics to Grafana Cloud
 */
export function stopMetricsPush(): void {
  if (pushInterval) {
    clearInterval(pushInterval);
    pushInterval = null;
    console.log("[Metrics] Grafana Cloud push stopped");
  }
}
