/**
 * dsh-memories store — JSON-file backed, project-scoped key-value memory.
 * Storage layout: ~/.dsh/dsh-memories/<scope>.json
 *   { "entries": { "<key>": { "value": string, "createdAt": number, "updatedAt": number } } }
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'

const ROOT = join(homedir(), '.dsh', 'dsh-memories')

export function normalizeScope(scope) {
  const s = typeof scope === 'string' && scope.trim() ? scope.trim() : 'global'
  // Keep scopes filesystem-safe and short.
  const safe = s.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80)
  return safe || 'global'
}

function fileOf(scope) {
  return join(ROOT, `${normalizeScope(scope)}.json`)
}

function readScope(scope) {
  try {
    const f = fileOf(scope)
    if (existsSync(f)) {
      const data = JSON.parse(readFileSync(f, 'utf8'))
      if (data && typeof data === 'object' && data.entries) return data
    }
  } catch {
    /* corrupted file: start over */
  }
  return { entries: {} }
}

function writeScope(scope, data) {
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(fileOf(scope), JSON.stringify(data, null, 2), 'utf8')
}

export function listScopes() {
  try {
    if (!existsSync(ROOT)) return []
    return readdirSync(ROOT).filter((f) => f.endsWith('.json')).map((f) => basename(f, '.json'))
  } catch {
    return []
  }
}

export function get(scope, key) {
  const data = readScope(scope)
  const e = data.entries[key]
  return e ? { key, value: e.value, createdAt: e.createdAt, updatedAt: e.updatedAt } : undefined
}

export function list(scope) {
  const data = readScope(scope)
  return Object.entries(data.entries)
    .map(([key, e]) => ({ key, value: e.value, createdAt: e.createdAt, updatedAt: e.updatedAt }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

export function set(scope, key, value) {
  if (typeof key !== 'string' || !key.trim()) throw new Error('memory key must be a non-empty string')
  if (typeof value !== 'string') value = JSON.stringify(value)
  const data = readScope(scope)
  const now = Date.now()
  const prev = data.entries[key]
  data.entries[key] = { value, createdAt: prev ? prev.createdAt : now, updatedAt: now }
  writeScope(scope, data)
  return { key, updatedAt: now, created: !prev }
}

export function remove(scope, key) {
  const data = readScope(scope)
  const existed = key in data.entries
  if (existed) {
    delete data.entries[key]
    writeScope(scope, data)
  }
  return { removed: existed }
}

export function search(scope, query, limit = 20) {
  const q = String(query || '').toLowerCase()
  const all = list(scope)
  if (!q) return all.slice(0, limit)
  return all
    .filter((e) => e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q))
    .slice(0, limit)
}

/** Whole-value summary for prompt injection: keys + first 120 chars of each value. */
export function summarize(scope, limit = 30) {
  return list(scope)
    .slice(0, limit)
    .map((e) => `${e.key}: ${e.value.slice(0, 120)}${e.value.length > 120 ? '…' : ''}`)
}
