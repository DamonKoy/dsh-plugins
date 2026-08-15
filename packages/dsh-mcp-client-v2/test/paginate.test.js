import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectTools, PaginationLimitError } from '../lib/paginate.js'

test('collectTools drains a two-page cursor chain', async () => {
  const page1 = { tools: [{ name: 'a' }, { name: 'b' }], nextCursor: 'cur-2' }
  const page2 = { tools: [{ name: 'c' }] }
  let fetchedCursor = null
  const result = await collectTools(
    async () => page1,
    async (cursor) => {
      fetchedCursor = cursor
      return page2
    },
  )
  assert.deepEqual(result.tools.map((t) => t.name), ['a', 'b', 'c'])
  assert.equal(result.pages, 2)
  assert.equal(result.duplicates, 0)
  assert.equal(fetchedCursor, 'cur-2')
})

test('collectTools dedupes tools repeated across pages (first occurrence wins)', async () => {
  let fetchCalls = 0
  const result = await collectTools(
    async () => ({ tools: [{ name: 'a' }, { name: 'b' }], nextCursor: 'c' }),
    async () => {
      fetchCalls += 1
      return { tools: [{ name: 'b' }, { name: 'c' }] } // 'b' is a duplicate
    },
  )
  assert.deepEqual(result.tools.map((t) => t.name), ['a', 'b', 'c'])
  assert.equal(result.duplicates, 1)
  assert.equal(fetchCalls, 1)
})

test('collectTools stops when nextCursor is absent or an empty string', async () => {
  const emptyCursor = await collectTools(
    async () => ({ tools: [{ name: 'x' }], nextCursor: '' }),
    async () => {
      throw new Error('fetchPage must not be called')
    },
  )
  assert.equal(emptyCursor.pages, 1)
  assert.deepEqual(emptyCursor.tools.map((t) => t.name), ['x'])

  const missingCursor = await collectTools(
    async () => ({ tools: [{ name: 'y' }] }),
    async () => {
      throw new Error('fetchPage must not be called')
    },
  )
  assert.equal(missingCursor.pages, 1)
  assert.deepEqual(missingCursor.tools.map((t) => t.name), ['y'])
})

test('collectTools enforces the maxPages cap and throws PaginationLimitError', async () => {
  let fetchCalls = 0
  await assert.rejects(
    collectTools(
      async () => ({ tools: [{ name: 't0' }], nextCursor: 'c1' }),
      async () => {
        fetchCalls += 1
        return { tools: [{ name: `t${fetchCalls}` }], nextCursor: `c${fetchCalls + 1}` }
      },
      { maxPages: 3 },
    ),
    (error) => {
      assert.ok(error instanceof PaginationLimitError)
      assert.equal(error.maxPages, 3)
      assert.equal(error.pages, 3)
      return true
    },
  )
  // listPage once + 2 fetchPage calls = 3 pages fetched before the cap threw
  assert.equal(fetchCalls, 2)
})

test('collectTools respects the default 20-page cap', async () => {
  let fetchCalls = 0
  await assert.rejects(
    collectTools(
      async () => ({ tools: [{ name: 't0' }], nextCursor: 'c1' }),
      async () => {
        fetchCalls += 1
        return { tools: [], nextCursor: `c${fetchCalls + 1}` }
      },
    ),
    (error) => {
      assert.ok(error instanceof PaginationLimitError)
      assert.equal(error.maxPages, 20)
      return true
    },
  )
  assert.equal(fetchCalls, 19)
})

test('collectTools skips malformed tool entries', async () => {
  const result = await collectTools(
    async () => ({
      tools: [{ name: 'a' }, { name: 42 }, null, {}, { name: '' }, { name: 'b' }],
    }),
    async () => {
      throw new Error('fetchPage must not be called')
    },
  )
  assert.deepEqual(result.tools.map((t) => t.name), ['a', 'b'])
  assert.equal(result.pages, 1)
})

test('collectTools validates its arguments', async () => {
  await assert.rejects(() => collectTools(null, async () => ({})), TypeError)
  await assert.rejects(() => collectTools(async () => ({}), null), TypeError)
  await assert.rejects(() => collectTools(async () => ({}), async () => ({}), { maxPages: 0 }), TypeError)
  await assert.rejects(() => collectTools(async () => ({}), async () => ({}), { maxPages: 1.5 }), TypeError)
})
