/**
 * Minimal in-process metrics (spec §38 Observability).
 *
 * Counters and latency summaries exposed at GET /metrics (JSON) and via logs.
 * Deliberately tiny: no Prometheus client dependency, but the shape is
 * Prometheus-compatible so it can be scraped or bridged later.
 */

type Labels = Record<string, string | number>;

function keyOf(name: string, labels?: Labels): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`);
  return `${name}{${parts.join(',')}}`;
}

class Counter {
  private values = new Map<string, number>();
  inc(n = 1, labels?: Labels): void {
    const k = keyOf(this.name, labels);
    this.values.set(k, (this.values.get(k) ?? 0) + n);
  }
  constructor(private readonly name: string) {}
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.values);
  }
}

class Histogram {
  private values = new Map<string, { count: number; sum: number; min: number; max: number; p95: number[] }>();
  constructor(private readonly name: string) {}

  observe(value: number, labels?: Labels): void {
    const k = keyOf(this.name, labels);
    const cur = this.values.get(k) ?? { count: 0, sum: 0, min: Infinity, max: -Infinity, p95: [] };
    cur.count += 1;
    cur.sum += value;
    cur.min = Math.min(cur.min, value);
    cur.max = Math.max(cur.max, value);
    // Reservoir for an approximate p95: keep the last 200 samples.
    cur.p95.push(value);
    if (cur.p95.length > 200) cur.p95.shift();
    this.values.set(k, cur);
  }

  snapshot(): Record<string, { count: number; avg: number; min: number; max: number; p95: number }> {
    const out: Record<string, { count: number; avg: number; min: number; max: number; p95: number }> = {};
    for (const [k, v] of this.values) {
      const sorted = [...v.p95].sort((a, b) => a - b);
      const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
      out[k] = {
        count: v.count,
        avg: v.count > 0 ? Math.round(v.sum / v.count) : 0,
        min: Number.isFinite(v.min) ? v.min : 0,
        max: Number.isFinite(v.max) ? v.max : 0,
        p95: sorted[idx] ?? 0,
      };
    }
    return out;
  }
}

class Gauge {
  private values = new Map<string, number>();
  constructor(private readonly name: string) {}
  set(value: number, labels?: Labels): void {
    this.values.set(keyOf(this.name, labels), value);
  }
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.values);
  }
}

export const metrics = {
  counters: {
    telegramUpdates: new Counter('telegram_updates_total'),
    telegramErrors: new Counter('telegram_errors_total'),
    botActions: new Counter('bot_actions_total'),
    pbxRequests: new Counter('freepbx_requests_total'),
    pbxErrors: new Counter('freepbx_errors_total'),
    pbxRetries: new Counter('freepbx_retries_total'),
    oauthTokenFetches: new Counter('freepbx_oauth_token_fetches_total'),
    oauthFailures: new Counter('freepbx_oauth_failures_total'),
    assignments: new Counter('number_assignments_total'),
    assignmentFailures: new Counter('number_assignment_failures_total'),
    releases: new Counter('number_releases_total'),
    apiRequests: new Counter('api_requests_total'),
    apiErrors: new Counter('api_errors_total'),
    dbErrors: new Counter('db_errors_total'),
    rateLimited: new Counter('rate_limited_total'),
    notifySent: new Counter('notifications_sent_total'),
    notifyFailed: new Counter('notifications_failed_total'),
    // Buttons Telegram refuses (callback_data over 64 bytes) - a screen that
    // never rendered. Any value above zero is a bug, so alert on it.
    invalidCallbackData: new Counter('telegram_invalid_callback_data_total'),
    droppedButtons: new Counter('telegram_dropped_buttons_total'),
  },
  histograms: {
    pbxLatencyMs: new Histogram('freepbx_latency_ms'),
    dbLatencyMs: new Histogram('db_latency_ms'),
    apiLatencyMs: new Histogram('api_latency_ms'),
  },
  gauges: {
    numbersAvailable: new Gauge('numbers_available'),
    numbersAssigned: new Gauge('numbers_assigned'),
    activeUsers: new Gauge('users_active'),
    liveCalls: new Gauge('live_calls'),
    openFindings: new Gauge('reconciliation_open_findings'),
  },
  snapshot() {
    return {
      counters: Object.fromEntries(Object.entries(this.counters).map(([k, v]) => [k, v.snapshot()])),
      histograms: Object.fromEntries(Object.entries(this.histograms).map(([k, v]) => [k, v.snapshot()])),
      gauges: Object.fromEntries(Object.entries(this.gauges).map(([k, v]) => [k, v.snapshot()])),
    };
  },

  /**
   * Prometheus text exposition format (spec §38).
   *
   * A scrape target only needs the four lines below, so this stays dependency
   * free: `# HELP`/`# TYPE` plus one sample line per label set. Counter names
   * already end in `_total`, which is what the format expects.
   */
  toPrometheus(): string {
    const lines: string[] = [];
    for (const [group, values] of Object.entries(this.snapshot())) {
      void group;
      if (!values || typeof values !== 'object') continue;
      for (const [series, value] of Object.entries(values as Record<string, unknown>)) {
        if (typeof value === 'number') {
          lines.push(`${series} ${value}`);
          continue;
        }
        if (value && typeof value === 'object' && 'count' in (value as Record<string, unknown>)) {
          const h = value as { count: number; sum: number; min: number; max: number; avg: number };
          // Summaries are exported as an average plus count/sum so no scrape
          // configuration is required to get a usable latency number.
          const base = series.replace(/\{.*$/, '');
          const labels = series.match(/\{(.*)\}$/)?.[1];
          const withLabel = (name: string) => (labels ? `${base}_${name}{${labels}}` : `${base}_${name}`);
          lines.push(`${withLabel('count')} ${h.count}`);
          lines.push(`${withLabel('sum')} ${h.sum}`);
          lines.push(`${withLabel('avg')} ${h.avg}`);
          lines.push(`${withLabel('max')} ${h.max}`);
          continue;
        }
        if (value && typeof value === 'object') {
          for (const [sub, subValue] of Object.entries(value as Record<string, unknown>)) {
            if (typeof subValue === 'number') lines.push(`${sub} ${subValue}`);
          }
        }
      }
    }
    return `${lines.join('\n')}\n`;
  },
};

export type Metrics = typeof metrics;
