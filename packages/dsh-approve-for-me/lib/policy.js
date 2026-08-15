/**
 * dsh-approve-for-me policy engine — pure, unit-testable.
 *
 * Modes:
 *   'off'    — plugin does not intervene (everything falls through to human).
 *   'review' — read-only tools auto-approve; dangerous commands auto-deny;
 *              everything else still asks the human.
 *   'auto'   — everything auto-approves EXCEPT dangerous commands, which
 *              auto-deny (fail-closed security floor).
 */

// Commands that must never run unattended, in either auto or review mode.
// Each entry is a RegExp tested against the trimmed shell command.
export const DANGEROUS_PATTERNS = [
  // recursive root/home destruction
  /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+(?:\/|\/\*|~|\*)\s*(?:[;&|]|$)/,
  /\brm\s+-[a-zA-Z]*rf[a-zA-Z]*\s+(?:\.|\/)\s*$/,
  // filesystem / partition / device leveling
  /\bmkfs(?:\.\w+)?\s+/,
  /\bdd\s+.*\bof=\/dev\/(?:sd|hd|nvme|disk)/,
  /\b(?:fdisk|parted|gdisk)\s+\/dev\//,
  /\b(?:shutdown|reboot|halt|poweroff)\b/,
  // fork bomb
  /:\(\s*\)\s*\{[^}]*:\|:&/,
  // recursive permission/ownership nukes
  /\bchmod\s+-[a-zA-Z]*R\s+[0-7]{3,4}\s+\//,
  /\bchown\s+-[a-zA-Z]*R\s+[^\s]+\s+\//,
  // pipe-to-shell remote code execution
  /\b(?:curl|wget)\b[^|;]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/,
  // sudo variants of the above
  /\bsudo\s+(?:rm\s+-[a-zA-Z]*rf|\bmkfs|\bdd\s+.*\bof=\/dev\/)/,
]

// Tools that only read state — safe to auto-approve in review mode.
export const READONLY_TOOLS = new Set([
  'read',
  'glob',
  'grep',
  'read_image',
  'get_goal',
  'job_list',
  'agent_teams_status',
  'list_agents',
  'ssh_list',
  'redact_text',
  'redact_secret_status',
  'cordis_inspect_list',
  'cordis_inspect_query',
  'cordis_inspect_self',
  'x_search',
  'read_page',
  'web_search',
  'visualize',
])

/**
 * Classify one shell command string.
 * @returns 'dangerous' | 'safe'
 */
export function classifyCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return 'safe'
  const cmd = command.trim()
  for (const re of DANGEROUS_PATTERNS) {
    if (re.test(cmd)) return 'dangerous'
  }
  return 'safe'
}

/**
 * Decide one approval request.
 * @param {object} opts
 * @param {'off'|'review'|'auto'} opts.mode
 * @param {string} opts.toolName tool name the approval is about
 * @param {string} [opts.command] shell command when the tool is a shell runner
 * @returns {'allow'|'deny'|'ask'}
 */
export function decide({ mode, toolName, command }) {
  if (mode === 'off') return 'ask'
  const name = typeof toolName === 'string' ? toolName : ''
  if (name === 'bash' || name === 'pwsh' || name === 'ssh_exec' || name === 'ssh_cluster') {
    const cls = classifyCommand(command)
    if (cls === 'dangerous') return 'deny'
  }
  if (mode === 'auto') return 'allow'
  if (mode === 'review' && READONLY_TOOLS.has(name)) return 'allow'
  return 'ask'
}
