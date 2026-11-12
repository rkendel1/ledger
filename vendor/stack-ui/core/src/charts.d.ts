// Types for @stack-ui/core/charts (docs/charts.md). Charts return view trees
// that dom.js, html.js and the React binding render.

/** A category name, a number, or (xType "time") epoch milliseconds or an ISO date. */
export type ChartX = string | number;
/** One value. `null` is missing: a gap in lines and areas, no bar, "—" in the table. */
export interface ChartDataPoint { x: ChartX; y: number | null }
export interface ChartSeries {
  /** Stable identity: keys legend toggles and `data-series`. Unique per chart. */
  id: string;
  /** Human-readable name shown in the legend, tooltips and data table. */
  label: string;
  /** Points in any order; one per x. Missing x values are treated as null. */
  data: ChartDataPoint[];
  /** Drawn? Hidden series stay in the legend (so they can be shown again) but leave the plot and table. */
  hidden?: boolean;
  /** Palette colour 1–8 (--stack-color-chart-N). Default: the series' position. */
  palette?: number;
  /** Product metadata; charts ignore it. */
  meta?: Record<string, unknown>;
}
/** How values are written: a function, or these options (en-US, deterministic: no Intl). */
export type ChartFormat = ((value: number) => string) | {
  style?: 'number' | 'currency' | 'percent';
  /** ISO 4217 code for style "currency" (default USD). */
  currency?: string;
  /** Presentation only: divide before writing (minor units → major units). */
  divisor?: number;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  /** 1.2K, 3.4M. */
  compact?: boolean;
  suffix?: string;
};
/** A view tree: { t: tag, a: attributes, c: children, on?: handlers }. */
export interface ViewTree { t: string; a: Record<string, unknown>; c: unknown[]; on?: Record<string, (...args: unknown[]) => void>; k?: string }
/** Chart props: see @stack-ui/react's LineChartProps and friends for the documented fields. */
export type ChartProps = { title: string; series: ChartSeries[]; [option: string]: unknown };
export declare function LineChart(props: ChartProps): ViewTree;
export declare function AreaChart(props: ChartProps): ViewTree;
export declare function BarChart(props: ChartProps): ViewTree;
export declare function StackedBarChart(props: ChartProps): ViewTree;
export declare function DonutChart(props: ChartProps): ViewTree;
export declare function Sparkline(props: { label: string; data: ChartDataPoint[]; [option: string]: unknown }): ViewTree;
export declare function formatChartValue(value: number | null | undefined, format?: ChartFormat): string;
export declare function niceTicks(min: number, max: number, count?: number): { min: number; max: number; ticks: number[] };
export declare function normalizeSeries(kind: string, series: ChartSeries[], xType?: 'category' | 'time' | 'number'): { keys: Array<string | number>; series: Array<{ id: string; label: string; hidden: boolean; palette: number; y: Array<number | null> }> };
export declare const CHART_PALETTE_SIZE: number;
export declare const CHARTS: Readonly<{ LineChart: typeof LineChart; AreaChart: typeof AreaChart; BarChart: typeof BarChart; StackedBarChart: typeof StackedBarChart; DonutChart: typeof DonutChart; Sparkline: typeof Sparkline }>;
