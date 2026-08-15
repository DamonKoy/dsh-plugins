/**
 * dsh-usage-cost
 * Usage and cost tracking for DeepSeek Harness.
 *
 * Hooks the `llm/stream` waterfall to accumulate token usage and estimated
 * USD cost per model call, settles per-turn deltas into a daily stats file
 * on `agent/turn-stopping`, warns when configured budget thresholds are
 * exceeded, and exposes a `usage_report` model tool plus a
 * `usage-cost/status` RPC.
 *
 * Config file: ~/.dsh/dsh-usage-cost.json  (optional, re-read on every use)
 *   {
 *     "prices": {
 *       "deepseek-official/deepseek-v4-flash": {
 *         "inputPerM": 0.28, "outputPerM": 0.42,
 *         "cacheReadPerM": 0.028, "cacheWritePerM": 0.42
 *       }
 *     },
 *     "dailyBudgetUsd": 2,
 *     "sessionBudgetUsd": 0.5
 *   }
 *
 * Stats file: ~/.dsh/dsh-usage-cost/stats.json
 *   {
 *     "byDate":  { "2026-08-16": { calls, inputTokens, ..., costUsd } },
 *     "byModel": { "provider/model": { calls, inputTokens, ..., costUsd } }
 *   }
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { estimateCost } from './cost.js'

const HOME = homedir()
const CONFIG_PATH = join(HOME, '.dsh', 'dsh-usage-cost.json')
const STATS_DIR = join(HOME, '.dsh', 'dsh-usage-cost')
const STATS_PATH = join(STATS_DIR, 'stats.json')

/** Fresh zero-valued accumulator bucket. */
function zeroStats() {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
  }
}

// In-memory session accumulator: global across the process lifetime, plus a
// per provider/model bucket. The lastSettled* snapshots feed delta settlement
// every time a turn closes.
const sessionStats = zeroStats()
const byModel = new Map()
const lastSettled = zeroStats()
const lastSettledByModel = new Map()
const warnedDates = new Set()
let sessionWarned = false

function loadConfig() {
  try {
    if (existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
      if (cfg && typeof cfg === 'object') return cfg
    }
  } catch {
    /* malformed or unreadable config: fall through to defaults */
  }
  return {}
}

/** Read the stats file, normalizing every bucket so partial files stay safe. */
function loadStats() {
  try {
    if (existsSync(STATS_PATH)) {
      const stats = JSON.parse(readFileSync(STATS_PATH, 'utf8'))
      if (stats && typeof stats === 'object') {
        return {
          byDate: normalizeBuckets(stats.byDate),
          byModel: normalizeBuckets(stats.byModel),
        }
      }
    }
  } catch {
    /* corrupt stats file: start fresh */
  }
  return { byDate: {}, byModel: {} }
}

function normalizeBuckets(buckets) {
  const out = {}
  if (buckets && typeof buckets === 'object') {
    for (const [key, bucket] of Object.entries(buckets)) {
      out[key] = normalizeBucket(bucket)
    }
  }
  return out
}

function normalizeBucket(bucket) {
  const out = zeroStats()
  if (bucket && typeof bucket === 'object') {
    out.calls = toNum(bucket.calls)
    out.inputTokens = toNum(bucket.inputTokens)
    out.outputTokens = toNum(bucket.outputTokens)
    out.cacheReadTokens = toNum(bucket.cacheReadTokens)
    out.cacheWriteTokens = toNum(bucket.cacheWriteTokens)
    out.reasoningTokens = toNum(bucket.reasoningTokens)
    out.costUsd = toNum(bucket.costUsd)
  }
  return out
}

function saveStats(stats) {
  mkdirSync(STATS_DIR, { recursive: true })
  writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2) + '\n', 'utf8')
}

/** Local calendar date (not UTC), so "today" matches the user's day. */
function todayKey() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function toNum(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function addStats(target, source) {
  target.calls += source.calls || 0
  target.inputTokens += source.inputTokens || 0
  target.outputTokens += source.outputTokens || 0
  target.cacheReadTokens += source.cacheReadTokens || 0
  target.cacheWriteTokens += source.cacheWriteTokens || 0
  target.reasoningTokens += source.reasoningTokens || 0
  target.costUsd += source.costUsd || 0
  return target
}

function deltaStats(current, previous) {
  return {
    calls: current.calls - previous.calls,
    inputTokens: current.inputTokens - previous.inputTokens,
    outputTokens: current.outputTokens - previous.outputTokens,
    cacheReadTokens: current.cacheReadTokens - previous.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens - previous.cacheWriteTokens,
    reasoningTokens: current.reasoningTokens - previous.reasoningTokens,
    costUsd: current.costUsd - previous.costUsd,
  }
}

/**
 * Record one usage chunk (one `usage` chunk of one model stream) into the
 * session accumulator and its provider/model bucket. `countCall` is true for
 * the first usage chunk of a stream so one model call is counted once even
 * when an adapter emits several usage chunks.
 */
function recordUsage(provider, model, usage, countCall) {
  const modelKey = `${String(provider ?? 'unknown')}/${String(model ?? 'unknown')}`
  const inputTokens = toNum(usage.inputTokens)
  const outputTokens = toNum(usage.outputTokens)
  const cacheReadTokens = toNum(usage.cacheReadTokens)
  const cacheWriteTokens = toNum(usage.cacheWriteTokens)
  const reasoningTokens = toNum(usage.reasoningTokens)

  const cfg = loadConfig()
  const prices = cfg && typeof cfg.prices === 'object' ? cfg.prices : {}
  const costUsd = estimateCost(
    modelKey,
    { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
    prices[modelKey],
  )

  if (countCall) sessionStats.calls += 1
  sessionStats.inputTokens += inputTokens
  sessionStats.outputTokens += outputTokens
  sessionStats.cacheReadTokens += cacheReadTokens
  sessionStats.cacheWriteTokens += cacheWriteTokens
  sessionStats.reasoningTokens += reasoningTokens
  sessionStats.costUsd += costUsd

  let bucket = byModel.get(modelKey)
  if (!bucket) {
    bucket = zeroStats()
    byModel.set(modelKey, bucket)
  }
  if (countCall) bucket.calls += 1
  bucket.inputTokens += inputTokens
  bucket.outputTokens += outputTokens
  bucket.cacheReadTokens += cacheReadTokens
  bucket.cacheWriteTokens += cacheWriteTokens
  bucket.reasoningTokens += reasoningTokens
  bucket.costUsd += costUsd
}

/**
 * Settle usage accumulated since the last settlement into the daily stats
 * file, then check budget thresholds and warn once per threshold crossing.
 */
function settle() {
  const delta = deltaStats(sessionStats, lastSettled)
  if (delta.calls <= 0) return

  const stats = loadStats()
  const today = todayKey()
  const dayBucket = normalizeBucket(stats.byDate[today])
  addStats(dayBucket, delta)
  stats.byDate[today] = dayBucket

  for (const [key, bucket] of byModel) {
    const prev = lastSettledByModel.get(key) || zeroStats()
    const modelDelta = deltaStats(bucket, prev)
    if (modelDelta.calls > 0) {
      const target = normalizeBucket(stats.byModel[key])
      addStats(target, modelDelta)
      stats.byModel[key] = target
    }
  }

  saveStats(stats)

  Object.assign(lastSettled, { ...sessionStats })
  lastSettledByModel.clear()
  for (const [key, bucket] of byModel) lastSettledByModel.set(key, { ...bucket })

  checkBudgets(stats, today)
}

function checkBudgets(stats, today) {
  const cfg = loadConfig()
  const dailyBudgetUsd = typeof cfg.dailyBudgetUsd === 'number' ? cfg.dailyBudgetUsd : null
  const sessionBudgetUsd = typeof cfg.sessionBudgetUsd === 'number' ? cfg.sessionBudgetUsd : null
  const dayCost = stats.byDate[today] ? stats.byDate[today].costUsd : 0

  if (dailyBudgetUsd != null && dayCost > dailyBudgetUsd && !warnedDates.has(today)) {
    warnedDates.add(today)
    console.warn(`[dsh-usage-cost] 今日用量超预算: $${dayCost.toFixed(4)} > $${dailyBudgetUsd} (${today})`)
  }
  if (sessionBudgetUsd != null && sessionStats.costUsd > sessionBudgetUsd && !sessionWarned) {
    sessionWarned = true
    console.warn(`[dsh-usage-cost] 本次会话用量超预算: $${sessionStats.costUsd.toFixed(4)} > $${sessionBudgetUsd}`)
  }
}

/** Current usage/cost/budget snapshot for the tool and the RPC. */
function status() {
  const cfg = loadConfig()
  const stats = loadStats()
  const today = todayKey()
  const todayStats = normalizeBucket(stats.byDate[today])
  const dailyBudgetUsd = typeof cfg.dailyBudgetUsd === 'number' ? cfg.dailyBudgetUsd : null
  const sessionBudgetUsd = typeof cfg.sessionBudgetUsd === 'number' ? cfg.sessionBudgetUsd : null

  return {
    today: { ...todayStats },
    session: { ...sessionStats },
    byModel: Object.fromEntries([...byModel.entries()].map(([key, value]) => [key, { ...value }])),
    budget: {
      dailyBudgetUsd,
      sessionBudgetUsd,
      dailyExceeded: dailyBudgetUsd != null && todayStats.costUsd > dailyBudgetUsd,
      sessionExceeded: sessionBudgetUsd != null && sessionStats.costUsd > sessionBudgetUsd,
    },
  }
}

// Register a model tool: prefer the harness.defineTool / harness.registerTool
// pair (sandbox / link-package realm) and fall back to the host-realm
// ctx.tools.register API used by official plugins. Never throws from apply.
function registerTool(ctx, definition) {
  try {
    if (typeof harness !== 'undefined' && harness && typeof harness.defineTool === 'function' && typeof harness.registerTool === 'function') {
      try {
        return harness.registerTool(ctx, harness.defineTool(definition))
      } catch (error) {
        console.warn(`[dsh-usage-cost] defineTool failed for "${definition.name}": ${error.message || String(error)}; retrying with unconstrained parameters`)
        return harness.registerTool(ctx, harness.defineTool({ ...definition, parameters: {} }))
      }
    }
    if (ctx && ctx.tools && typeof ctx.tools.register === 'function') {
      return ctx.tools.register(definition)
    }
    console.warn(`[dsh-usage-cost] no tool registration API available; tool "${definition.name}" not registered`)
  } catch (error) {
    console.warn(`[dsh-usage-cost] tool registration failed for "${definition.name}": ${error.message || String(error)}`)
  }
  return () => {}
}

// Package-private RPC is only available in the sandbox / link-package realm;
// in the host realm there is no harness, so registration is skipped.
function registerRpc(path, handler) {
  if (typeof harness !== 'undefined' && harness && typeof harness.handle === 'function') {
    try {
      return harness.handle(path, handler)
    } catch (error) {
      console.warn(`[dsh-usage-cost] RPC registration failed for "${path}": ${error.message || String(error)}`)
    }
  }
  return undefined
}

export default {
  name: 'usage-cost',
  inject: ['tools'],
  apply(ctx) {
    // Accumulate usage from the llm/stream waterfall. `next()` returns the
    // downstream AsyncIterable; awaiting it is a safe no-op that also covers
    // promise-returning downstream wrappers. Never use `yield* next()`.
    ctx.on('llm/stream', async function* (options, next) {
      const stream = await next()
      let callCounted = false
      for await (const chunk of stream) {
        if (chunk && chunk.type === 'usage' && chunk.usage) {
          try {
            recordUsage(options.provider, options.model, chunk.usage, !callCounted)
            callCounted = true
          } catch (err) {
            console.error('[dsh-usage-cost] usage recording error:', err)
          }
        }
        yield chunk
      }
    })

    // Settle per-turn deltas into the daily stats file when a turn closes.
    ctx.on('agent/turn-stopping', () => {
      try {
        settle()
      } catch (err) {
        console.error('[dsh-usage-cost] settlement error:', err)
      }
    })

    // Model tool: report current usage and budget state.
    registerTool(ctx, {
      name: 'usage_report',
      description:
        'Report dsh-usage-cost usage: today and current-session token counts and estimated USD cost, per-model breakdown, and configured daily/session budgets with exceeded flags. Read-only, no arguments.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute() {
        return status()
      },
    })

    // Package-private RPC for client halves and other plugins.
    registerRpc('usage-cost/status', () => status())
  },
}
