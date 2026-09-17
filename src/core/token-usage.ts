import { record } from "./canonical.js";

/** Complete exact counters from one app-server token-usage snapshot. */
export interface TokenUsageCounters {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

/** Counter names required before cumulative usage may be attributed. */
const TOKEN_USAGE_COUNTERS = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
] as const;

/** Exact zero baseline for a newly created app-server thread. */
export const ZERO_TOKEN_USAGE: Readonly<TokenUsageCounters> = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

/** Accepts only nonnegative integers JavaScript can represent exactly. */
export function tokenUsageCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Reads one complete exact nonnegative counter snapshot. */
export function tokenUsageCounters(
  value: unknown,
): TokenUsageCounters | undefined {
  const breakdown = record(value);
  if (!breakdown) return undefined;
  const result = {} as TokenUsageCounters;
  for (const name of TOKEN_USAGE_COUNTERS) {
    const count = tokenUsageCount(breakdown[name]);
    if (count === undefined) return undefined;
    result[name] = count;
  }
  return result;
}

/** Subtracts cumulative counters when every result remains exact and nonnegative. */
export function subtractTokenUsage(
  total: TokenUsageCounters,
  baseline: TokenUsageCounters,
): TokenUsageCounters | undefined {
  const result = {} as TokenUsageCounters;
  for (const name of TOKEN_USAGE_COUNTERS) {
    const count = total[name] - baseline[name];
    if (count < 0) return undefined;
    result[name] = count;
  }
  return result;
}
