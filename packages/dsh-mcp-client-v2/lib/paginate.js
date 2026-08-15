/**
 * dsh-mcp-client-v2: paginated tool discovery.
 *
 * Pure, dependency-free helpers for draining an MCP `tools/list` cursor chain.
 * Kept separate from the transport layer so the pagination semantics (dedupe,
 * page cap, malformed-entry tolerance) are directly unit-testable.
 */

/** Thrown when a cursor chain does not terminate within `maxPages` pages. */
export class PaginationLimitError extends Error {
  constructor(message, { maxPages, pages } = {}) {
    super(message)
    this.name = 'PaginationLimitError'
    this.maxPages = maxPages
    this.pages = pages
  }
}

/**
 * Collect every tool from a paginated `tools/list` response chain.
 *
 * Protocol shape (MCP 2026-07-28 / tools/list):
 *   page = { tools: Tool[], nextCursor?: string }
 *
 * The first page comes from `listPage()`, every subsequent page from
 * `fetchPage(cursor)` with the previous page's `nextCursor`.
 *
 * Behaviour:
 * - Tools are deduplicated by raw `tool.name`; the first occurrence wins and
 *   later duplicates are counted (a server that re-lists a tool must not
 *   produce duplicate registrations).
 * - Entries that are not objects with a non-empty string `name` are skipped
 *   (defensive: the server is a network trust boundary).
 * - The chain is bounded by `maxPages` (default 20). If a `nextCursor` still
 *   remains after `maxPages` pages, `PaginationLimitError` is thrown instead
 *   of looping forever.
 * - An empty-string cursor terminates the chain (treated the same as an
 *   absent cursor).
 *
 * @param listPage - function returning the first page ({ tools, nextCursor? }).
 * @param fetchPage - function(cursor) returning the next page.
 * @param options - { maxPages } page cap, positive integer, default 20.
 * @returns { tools, pages, duplicates } - the deduped tool list, the number of
 *   pages actually fetched, and how many duplicate entries were skipped.
 * @throws {TypeError} when listPage/fetchPage are not functions or maxPages
 *   is not a positive integer.
 * @throws {PaginationLimitError} when the cursor chain exceeds maxPages pages.
 */
export async function collectTools(listPage, fetchPage, { maxPages = 20 } = {}) {
  if (typeof listPage !== 'function') {
    throw new TypeError('collectTools: listPage must be a function returning { tools, nextCursor? }')
  }
  if (typeof fetchPage !== 'function') {
    throw new TypeError('collectTools: fetchPage must be a function accepting a cursor')
  }
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new TypeError('collectTools: maxPages must be a positive integer')
  }

  const tools = []
  const seen = new Set()
  let pages = 0
  let duplicates = 0
  let cursor

  while (true) {
    const response = pages === 0 ? await listPage() : await fetchPage(cursor)
    pages += 1
    const list = response && Array.isArray(response.tools) ? response.tools : []
    for (const tool of list) {
      if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string' || tool.name.length === 0) continue
      if (seen.has(tool.name)) {
        duplicates += 1
        continue
      }
      seen.add(tool.name)
      tools.push(tool)
    }
    const next = response && typeof response.nextCursor === 'string' && response.nextCursor.length > 0
      ? response.nextCursor
      : undefined
    if (next === undefined) break
    if (pages >= maxPages) {
      throw new PaginationLimitError(
        `collectTools: tools/list pagination exceeded ${maxPages} pages; aborting to avoid an infinite loop`,
        { maxPages, pages },
      )
    }
    cursor = next
  }

  return { tools, pages, duplicates }
}
