/**
 * dsh-usage-cost cost estimation.
 *
 * Pure token-to-USD estimation for one model call. No file I/O, no harness
 * imports and no side effects, so the module is unit-testable in isolation.
 *
 * A model key has the form `${provider}/${model}`, e.g.
 * `deepseek-official/deepseek-v4-flash`. Built-in defaults:
 *
 *   - DeepSeek family (provider or model contains "deepseek"):
 *     input $0.28/M, output $0.42/M, cache read $0.028/M, cache write $0.42/M
 *   - everything else:
 *     input $2/M, output $8/M, cache read $0.2/M, cache write $2/M
 *
 * Per-model overrides (the `prices` field of the plugin config) replace
 * individual entries on top of the defaults. All prices are USD per 1M tokens.
 */

export const DEFAULT_PRICES = {
  deepseek: {
    inputPerM: 0.28,
    outputPerM: 0.42,
    cacheReadPerM: 0.028,
    cacheWritePerM: 0.42,
  },
  default: {
    inputPerM: 2,
    outputPerM: 8,
    cacheReadPerM: 0.2,
    cacheWritePerM: 2,
  },
}

const DEEPSEEK_RE = /deepseek/i

/** Whether a model key belongs to the DeepSeek family. */
export function isDeepSeekKey(modelKey) {
  return DEEPSEEK_RE.test(String(modelKey ?? ''))
}

/**
 * Effective per-model prices for one model key.
 *
 * @param {string} modelKey - `${provider}/${model}` key.
 * @param {object} [overrides] - optional per-model price overrides
 *   ({ inputPerM, outputPerM, cacheReadPerM, cacheWritePerM }).
 * @returns the four effective per-million-token prices in USD.
 */
export function resolvePrices(modelKey, overrides = {}) {
  const base = isDeepSeekKey(modelKey)
    ? DEFAULT_PRICES.deepseek
    : DEFAULT_PRICES.default
  const o = overrides && typeof overrides === 'object' ? overrides : {}
  return {
    inputPerM: priceOf(o.inputPerM, base.inputPerM),
    outputPerM: priceOf(o.outputPerM, base.outputPerM),
    cacheReadPerM: priceOf(o.cacheReadPerM, base.cacheReadPerM),
    cacheWritePerM: priceOf(o.cacheWritePerM, base.cacheWritePerM),
  }
}

/**
 * Estimated USD cost of one model call.
 *
 * @param {string} modelKey - `${provider}/${model}` key.
 * @param {object} [usage] - TokenUsage-shaped counts
 *   ({ inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens? }).
 * @param {object} [overrides] - optional per-model price overrides.
 * @returns the estimated cost in USD (never negative).
 */
export function estimateCost(modelKey, usage = {}, overrides = {}) {
  const p = resolvePrices(modelKey, overrides)
  const inputTokens = countOf(usage.inputTokens)
  const outputTokens = countOf(usage.outputTokens)
  const cacheReadTokens = countOf(usage.cacheReadTokens)
  const cacheWriteTokens = countOf(usage.cacheWriteTokens)
  return (
    (inputTokens * p.inputPerM) / 1e6 +
    (outputTokens * p.outputPerM) / 1e6 +
    (cacheReadTokens * p.cacheReadPerM) / 1e6 +
    (cacheWriteTokens * p.cacheWritePerM) / 1e6
  )
}

/** Coerce a token count to a finite non-negative number. */
function countOf(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Coerce a price to a finite non-negative number, falling back on `fallback`. */
function priceOf(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return fallback
}
