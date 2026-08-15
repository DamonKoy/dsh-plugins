/**
 * Unit tests for lib/cost.js — pure cost estimation (no file I/O, no harness).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateCost,
  resolvePrices,
  isDeepSeekKey,
  DEFAULT_PRICES,
} from '../lib/cost.js'

test('deepseek default pricing: input and output', () => {
  // deepseek: in $0.28/M, out $0.42/M -> 0.28 + 0.42 = 0.70
  const cost = estimateCost('deepseek-official/deepseek-v4-flash', {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  })
  assert.equal(cost, 0.7)
})

test('deepseek default pricing: cache read and write', () => {
  // cacheRead 1M * 0.028 + cacheWrite 1M * 0.42 = 0.448
  const cost = estimateCost('deepseek/deepseek-chat', {
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
  })
  assert.ok(Math.abs(cost - 0.448) < 1e-9)
})

test('generic default pricing', () => {
  // generic: in $2/M, out $8/M -> 2 + 8 = 10
  const cost = estimateCost('openai/gpt-4o', {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  })
  assert.equal(cost, 10)
})

test('deepseek family detected by provider or model name', () => {
  assert.equal(isDeepSeekKey('deepseek-official/deepseek-v4-flash'), true)
  assert.equal(isDeepSeekKey('proxy/deepseek-v3'), true)
  assert.equal(isDeepSeekKey('openai/gpt-4o'), false)
})

test('per-model overrides replace individual entries on top of defaults', () => {
  const overrides = {
    inputPerM: 0.1,
    outputPerM: 0.2,
    cacheReadPerM: 0.01,
    cacheWritePerM: 0.2,
  }
  const cost = estimateCost('custom/anything', {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
  }, overrides)
  assert.equal(cost, 0.1 + 0.2 + 0.01 + 0.2)
})

test('resolvePrices merges overrides over the matching default tier', () => {
  const p = resolvePrices('deepseek-official/deepseek-v4-flash', { inputPerM: 1 })
  assert.equal(p.inputPerM, 1)
  assert.equal(p.outputPerM, DEFAULT_PRICES.deepseek.outputPerM)
  assert.equal(p.cacheReadPerM, DEFAULT_PRICES.deepseek.cacheReadPerM)
  const g = resolvePrices('openai/gpt-4o', { outputPerM: '3' })
  assert.equal(g.outputPerM, 3) // numeric strings are accepted
  assert.equal(g.inputPerM, DEFAULT_PRICES.default.inputPerM)
})

test('partial or missing usage counts as zero', () => {
  assert.equal(estimateCost('x/y', {}), 0)
  assert.equal(estimateCost('x/y', { inputTokens: 500_000 }), 1) // 0.5M * $2/M
  assert.equal(estimateCost('x/y', { outputTokens: 250_000 }), 2) // 0.25M * $8/M
})

test('negative or non-finite tokens clamp to zero', () => {
  const cost = estimateCost('openai/gpt-4o', {
    inputTokens: -5,
    outputTokens: Number.POSITIVE_INFINITY,
    cacheReadTokens: 'nope',
  })
  assert.equal(cost, 0)
})

test('invalid overrides fall back to defaults', () => {
  const p = resolvePrices('openai/gpt-4o', { inputPerM: -1, outputPerM: 'abc' })
  assert.equal(p.inputPerM, DEFAULT_PRICES.default.inputPerM)
  assert.equal(p.outputPerM, DEFAULT_PRICES.default.outputPerM)
})
