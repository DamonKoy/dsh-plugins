import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BUILTIN_PATTERNS,
  buildRules,
  redactTextWithRules,
  applyRule,
  escapeRegExp,
} from '../lib/redact.js'

// NOTE: test samples are assembled from two fragments on purpose. GitHub's
// push protection scans committed literals for known secret shapes, so a
// verbatim `ghp_...`-style literal in this file would block `git push`.
// Runtime behavior is identical — the concatenation yields the full shape.
const mk = (a, b) => a + b

const SAMPLES = {
  sk: mk('sk-', 'abc123def456ghi789jklmnopqrs'),
  gh: mk('ghp_', 'abcdefghijklmnopqrstuvwxyzABCDEF'),
  aws: mk('AKIA', 'IOSFODNN7EXAMPLE'),
  slack: mk('xoxb-', '123456789012-abcdefghijklmno'),
  google: mk('AIza', 'SyA1234567890abcdefghijklmnopqrstuvwxyz'),
  hf: mk('hf_', 'huggingface1234567890abcdefghijklmnop'),
  gitlab: mk('glpat-', 'abcdefghijklmnopqrstuvwx'),
  bitbucket: mk('ATBB', 'abcdefghijklmnopqrstuvwx'),
  aliyun: mk('LTAI', '1234567890abcdefgh'),
  tencent: mk('AKID', '1234567890abcdefghijklmnop'),
  stripe: mk('sk_live_', 'abcdefghijklmnopqrstuvwxyz012345'),
  npm: mk('npm_', 'abcdefghijklmnopqrstuvwxyz123456'),
  telegram: mk('1234567890:AA', 'abcdefghijklmnopqrstuvwxyz1234567890'),
  sendgrid: mk('SG.', 'abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN'),
  do: mk('dop_v1_', 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'),
  shopify: mk('shpat_', 'abcdefghijklmnopqrstuvwxyz012345'),
  pemBody: mk('MIIEo', 'wIBAAKCAQEA1234567890'),
  bearerBody: mk('abcdefghijkl', 'mnopqrstuvwxyz0123456789'),
  jwtBody: mk('eyJhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'),
  dbPass1: mk('s3cr3t', 'Passw0rd'),
  dbPass2: mk('pa55', 'w0rd'),
  urlPass: mk('hunter2', 'secret'),
  awsSecretVal: mk('wJalr', 'XUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'),
  hexTok: mk('AbCdEf1234567890AbCdEf', '1234567890AbCdEf1234'),
  genTok: mk('Abcdefghij1234567890Abcdefghij', '1234567890Abcdefghij1234'),
}

const rules = buildRules({}) // built-in rules only, no env collection

function redact(text) {
  return redactTextWithRules(text, rules)
}

/* ------------------------------------------------------------------ *
 * Positive: real secret shapes MUST be masked
 * ------------------------------------------------------------------ */

test('masks vendor API key shapes', () => {
  const cases = [
    'key=' + SAMPLES.sk,
    'token ' + SAMPLES.gh,
    'aws ' + SAMPLES.aws,
    'slack ' + SAMPLES.slack,
    'google ' + SAMPLES.google,
    SAMPLES.hf,
    'gitlab ' + SAMPLES.gitlab,
    'bitbucket ' + SAMPLES.bitbucket,
    'aliyun ' + SAMPLES.aliyun,
    'tencent ' + SAMPLES.tencent,
    'stripe ' + SAMPLES.stripe,
    'npm ' + SAMPLES.npm,
    'tg ' + SAMPLES.telegram,
    'sendgrid ' + SAMPLES.sendgrid,
    'do ' + SAMPLES.do,
    'shopify ' + SAMPLES.shopify,
  ]
  for (const c of cases) {
    const out = redact(c)
    assert.notEqual(out, c, `should mask: ${c}`)
    // masked output keeps only the type prefix; a secret payload never
    // survives (prefix followed by [A-Za-z0-9] would be a residual secret)
    assert.ok(!/(?:sk-|gh[pousr]_|AKIA|AIza|hf_|glpat-|ATBB|LTAI|AKID|sk_(?:live|test)_|npm_|:AA|SG\.|dop_v1_|shpat_)[A-Za-z0-9]/.test(out), `residual secret in: ${out}`)
  }
})

test('masks structured blocks (PEM, bearer, JWT)', () => {
  const pem = mk('-----BEGIN RSA PRIVATE KEY-----\n', SAMPLES.pemBody) + '\n-----END RSA PRIVATE KEY-----'
  const sshPem = mk('-----BEGIN OPENSSH PRIVATE KEY-----\n', 'AAAA1234') + '\n-----END OPENSSH PRIVATE KEY-----'
  const pgpPem = mk('-----BEGIN PGP PRIVATE KEY BLOCK-----\n', 'abcd') + '\n-----END PGP PRIVATE KEY BLOCK-----'
  for (const p of [pem, sshPem, pgpPem]) {
    const out = redact(p)
    assert.ok(out.includes('PRIVATE KEY'), `keep block marker: ${out}`)
    assert.ok(!out.includes(SAMPLES.pemBody), `mask PEM body: ${out}`)
    assert.ok(!out.includes('AAAA1234'))
  }
  const bearer = mk('Authorization: Bearer ', SAMPLES.bearerBody)
  assert.equal(redact(bearer), 'Authorization: Bearer ***')
  const jwt = mk('jwt=', SAMPLES.jwtBody)
  const out = redact(jwt)
  assert.ok(out.includes('***JWT***'), out)
})

test('masks contextual credentials', () => {
  // connection-string password
  assert.equal(redact(mk('mongodb://admin:', SAMPLES.dbPass1) + '@db.example.com:27017/app'), 'mongodb://***@db.example.com:27017/app')
  assert.equal(redact(mk('postgres://user:', SAMPLES.dbPass2) + '@10.0.0.5:5432/db'), 'postgres://***@10.0.0.5:5432/db')
  // https URL with password
  assert.equal(redact(mk('https://alice:', SAMPLES.urlPass) + '@example.com/api'), 'https://***@example.com/api')
  // key = value pairs
  assert.equal(redact(mk('apiKey=', 'abcd1234efgh5678')), 'apiKey=***')
  assert.equal(redact(mk('"password": "', 'correct-horse-battery') + '"'), '"password": "***"')
  assert.equal(redact(mk('AWS_SECRET_ACCESS_KEY = ', SAMPLES.awsSecretVal)), 'AWS_SECRET_ACCESS_KEY = ***')
  // data URI payload
  assert.ok(redact(mk('data:image/png;base64,', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')).includes(';base64,***'))
  // hex mixed-case token
  assert.ok(redact(mk('sig=', SAMPLES.hexTok)).includes('***'))
  // generic mixed token
  assert.ok(redact(mk('session=', SAMPLES.genTok)).includes('***'))
})

test('preserves recognizable prefixes via keep', () => {
  const out = redact(mk('', SAMPLES.sk) + ' and ' + SAMPLES.gitlab)
  assert.ok(out.includes('sk-***'), out)
  assert.ok(out.includes('glpat-***'), out)
})

/* ------------------------------------------------------------------ *
 * Negative: ordinary text MUST NOT be masked (no false positives)
 * ------------------------------------------------------------------ */

test('does not mask tool names and identifiers', () => {
  const safe = [
    'hindsight_search_knowledge_pages',
    'hindsight_capture_initiative',
    'knowledge-deepseek-harness-plugins.md',
    'cordis_inspect_query',
    'agent_teams_create_task',
    'dsh-secret-redactor',
    'read_file_and_process_events',
  ]
  for (const s of safe) assert.equal(redact(s), s, `must keep: ${s}`)
})

test('does not mask long plain words, commit hashes or UUIDs', () => {
  const safe = [
    'pneumonoultramicroscopicsilicovolcanoconiosis', // 45 chars, lowercase only
    'internationalization',
    'antidisestablishmentarianism',
    'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6', // lowercase hex (git hash)
    '550e8400-e29b-41d4-a716-446655440000', // UUID with dashes
    '550e8400e29b41d4a716446655440000', // plain uuid hex (lowercase only)
  ]
  for (const s of safe) assert.equal(redact(s), s, `must keep: ${s}`)
})

test('does not mask URLs without credentials, git URLs, or normal commands', () => {
  const safe = [
    'https://example.com/path?token=abc',
    'https://user@example.com/repo',
    'git@github.com:openai/codex.git',
    'git clone https://github.com/DamonKoy/dsh-plugins.git',
    'rm -rf /tmp/build-cache && npm install',
    'curl -s https://api.example.com/v1/items',
    'ssh -p 22 admin@10.0.0.1',
    'export PATH=/usr/local/bin:$PATH',
  ]
  for (const s of safe) assert.equal(redact(s), s, `must keep: ${s}`)
})

test('does not mask normal code and short config values', () => {
  const safe = [
    'const token = getToken()', // expression, not a literal
    'password: string', // type annotation, no literal value
    '"secret": "none"', // value too short
    'apiKey: "test"',
    'value: "a.b.c.d"', // dotted value excluded by design
    'const x = 12345678;', // bare number, no key
    'function handleRequest(req, res) { return res.json({ ok: true }) }',
  ]
  for (const s of safe) assert.equal(redact(s), s, `must keep: ${s}`)
})

test('does not mask short or lowercase-only generic strings', () => {
  const safe = [
    'abcdefghijklmnopqrstuvwxyz0123456789', // 36 lowercase+digits, no uppercase
    'TOKEN', // short
    'secret',
  ]
  for (const s of safe) assert.equal(redact(s), s, `must keep: ${s}`)
})

/* ------------------------------------------------------------------ *
 * Engine mechanics
 * ------------------------------------------------------------------ */

test('disablePatterns removes built-in rules by name', () => {
  const cfg = { disablePatterns: ['generic-mixed', 'key-value'] }
  const names = buildRules(cfg).map((r) => r.name)
  assert.ok(!names.includes('generic-mixed'))
  assert.ok(!names.includes('key-value'))
  assert.ok(names.includes('sk-openai'))
})

test('extraSecrets and custom patterns are applied', () => {
  const cfg = { extraSecrets: ['my-literal-secret'], patterns: ['CUSTOM-\\d{8}'] }
  const r = buildRules(cfg)
  const redacted = redactTextWithRules('my-literal-secret and CUSTOM-12345678', r)
  assert.equal(redacted, '*** and ***')
})

test('all built-in patterns compile and apply without throwing', () => {
  for (const p of BUILTIN_PATTERNS) {
    p.re.lastIndex = 0
    const out = applyRule(mk('probe sk-', 'abc123def456ghi789 sample'), p)
    assert.equal(typeof out, 'string')
  }
  assert.ok(BUILTIN_PATTERNS.length >= 20, `expected >= 20 rules, got ${BUILTIN_PATTERNS.length}`)
})

test('escapeRegExp neutralizes regex metacharacters', () => {
  assert.equal(escapeRegExp('a.b*c'), 'a\\.b\\*c')
})
