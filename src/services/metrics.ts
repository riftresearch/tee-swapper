import {
  Registry,
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
} from "prom-client";
import { pushTimeseries, type Timeseries } from "prometheus-remote-write";

// Metric type constants (prom-client doesn't export the MetricType enum at runtime)
const METRIC_TYPE_COUNTER = "counter";
const METRIC_TYPE_GAUGE = "gauge";
const METRIC_TYPE_HISTOGRAM = "histogram";

// Create a custom registry
export const registry = new Registry();

// Collect default Node.js metrics (memory, CPU, event loop, etc.)
collectDefaultMetrics({ register: registry });

// =============================================================================
// Grafana Cloud Remote Write Configuration
// =============================================================================

interface GrafanaCloudConfig {
  url: string;
  username: string;
  password: string;
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

// =============================================================================
// Grafana Cloud Remote Write
// =============================================================================

/**
 * Convert prom-client metrics to prometheus-remote-write timeseries format
 */
async function getTimeseries(): Promise<Timeseries[]> {
  const metrics = await registry.getMetricsAsJSON();
  const timeseries: Timeseries[] = [];
  const now = Date.now();

  for (const metric of metrics) {
    const metricName = metric.name;
    // Cast type to string for comparison (prom-client types are strings at runtime)
    const metricType = metric.type as unknown as string;

    if (metricType === METRIC_TYPE_COUNTER || metricType === METRIC_TYPE_GAUGE) {
      // Handle counter and gauge metrics
      for (const value of metric.values) {
        const labels: { __name__: string; [key: string]: string } = {
          __name__: metricName,
        };
        // Copy labels, converting to strings
        if (value.labels) {
          for (const [key, val] of Object.entries(value.labels)) {
            labels[key] = String(val);
          }
        }

        timeseries.push({
          labels,
          samples: [{ value: value.value as number, timestamp: now }],
        });
      }
    } else if (metricType === METRIC_TYPE_HISTOGRAM) {
      // Handle histogram metrics - emit bucket, sum, and count
      for (const value of metric.values) {
        const baseLabels: { [key: string]: string } = {};
        if (value.labels) {
          for (const [key, val] of Object.entries(value.labels)) {
            baseLabels[key] = String(val);
          }
        }
        // Get the metric name suffix from the value
        const valueName = (value as { metricName?: string }).metricName;

        if (valueName?.endsWith("_bucket")) {
          // Bucket metric
          timeseries.push({
            labels: {
              __name__: `${metricName}_bucket`,
              ...baseLabels,
            },
            samples: [{ value: value.value as number, timestamp: now }],
          });
        } else if (valueName?.endsWith("_sum")) {
          timeseries.push({
            labels: {
              __name__: `${metricName}_sum`,
              ...baseLabels,
            },
            samples: [{ value: value.value as number, timestamp: now }],
          });
        } else if (valueName?.endsWith("_count")) {
          timeseries.push({
            labels: {
              __name__: `${metricName}_count`,
              ...baseLabels,
            },
            samples: [{ value: value.value as number, timestamp: now }],
          });
        }
      }
    }
  }

  return timeseries;
}

/**
 * Push metrics to Grafana Cloud
 */
async function pushMetricsToGrafanaCloud(): Promise<void> {
  if (!grafanaCloudConfig) {
    return;
  }

  try {
    const timeseries = await getTimeseries();

    if (timeseries.length === 0) {
      return;
    }

    await pushTimeseries(timeseries, {
      url: grafanaCloudConfig.url,
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${grafanaCloudConfig.username}:${grafanaCloudConfig.password}`
        ).toString("base64")}`,
      },
    });
  } catch (error) {
    console.error("[Metrics] Failed to push to Grafana Cloud:", error);
  }
}

/**
 * Start pushing metrics to Grafana Cloud
 *
 * Reads configuration from environment variables:
 * - GRAFANA_CLOUD_URL: Remote write URL (e.g., https://prometheus-prod-XX-prod.grafana.net/api/prom/push)
 * - GRAFANA_CLOUD_USERNAME: Grafana Cloud user ID
 * - GRAFANA_CLOUD_API_KEY: Grafana Cloud API key
 */
export function startMetricsPush(): void {
  const url = process.env.GRAFANA_CLOUD_URL;
  const username = process.env.GRAFANA_CLOUD_USERNAME;
  const password = process.env.GRAFANA_CLOUD_API_KEY;

  if (!url || !username || !password) {
    console.log(
      "[Metrics] Grafana Cloud not configured. Set GRAFANA_CLOUD_URL, GRAFANA_CLOUD_USERNAME, and GRAFANA_CLOUD_API_KEY to enable remote push."
    );
    return;
  }

  grafanaCloudConfig = { url, username, password };

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
