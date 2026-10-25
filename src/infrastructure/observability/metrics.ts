import type { MetricsPort } from '../../application/ports.ts';

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

type Kind = 'counter' | 'gauge' | 'histogram';

interface Series {
  name: string;
  kind: Kind;
  labels: Record<string, string>;
  value: number;
  buckets?: number[];
  sum?: number;
  count?: number;
}

export class Metrics implements MetricsPort {
  private readonly series = new Map<string, Series>();

  increment(name: string, labels: Record<string, string> = {}, value = 1): void {
    const series = this.counter(name, labels);
    series.value += value;
  }

  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const series = this.ensure(name, 'gauge', labels);
    series.value = value;
  }

  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const series = this.ensure(name, 'histogram', labels);
    series.buckets ??= BUCKETS.map(() => 0);
    series.sum = (series.sum ?? 0) + value;
    series.count = (series.count ?? 0) + 1;
    BUCKETS.forEach((bucket, index) => {
      if (value <= bucket) series.buckets![index] = (series.buckets![index] ?? 0) + 1;
    });
  }

  render(): string {
    const lines: string[] = [];
    const declared = new Set<string>();
    for (const series of this.series.values()) {
      if (!declared.has(series.name)) {
        lines.push(`# TYPE ${series.name} ${series.kind}`);
        declared.add(series.name);
      }
      if (series.kind === 'histogram') {
        BUCKETS.forEach((bucket, index) => {
          lines.push(`${series.name}_bucket{${labelList({ ...series.labels, le: String(bucket) })}} ${series.buckets?.[index] ?? 0}`);
        });
        lines.push(`${series.name}_bucket{${labelList({ ...series.labels, le: '+Inf' })}} ${series.count ?? 0}`);
        lines.push(`${series.name}_sum{${labelList(series.labels)}} ${series.sum ?? 0}`);
        lines.push(`${series.name}_count{${labelList(series.labels)}} ${series.count ?? 0}`);
        continue;
      }
      lines.push(`${series.name}${formatLabels(series.labels)} ${series.value}`);
    }
    return `${lines.join('\n')}\n`;
  }

  private counter(name: string, labels: Record<string, string>): Series {
    return this.ensure(name, 'counter', labels);
  }

  private ensure(name: string, kind: Kind, labels: Record<string, string>): Series {
    const id = `${name}|${JSON.stringify(sortLabels(labels))}`;
    const existing = this.series.get(id);
    if (existing) return existing;
    const created: Series = { name, kind, labels, value: 0 };
    this.series.set(id, created);
    return created;
  }
}

function sortLabels(labels: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)));
}

function formatLabels(labels: Record<string, string>): string {
  const text = labelList(labels);
  return text.length === 0 ? '' : `{${text}}`;
}

function labelList(labels: Record<string, string>): string {
  return Object.entries(sortLabels(labels))
    .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
    .join(',');
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}
