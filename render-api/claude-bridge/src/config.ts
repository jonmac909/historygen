// Centralized bridge configuration. Every knob is an env var so the container
// can be retuned without a rebuild.

export const config = {
  host: '127.0.0.1', // loopback only — bridge must never be externally reachable
  port: parseInt(process.env.BRIDGE_PORT ?? '9001', 10),

  // Forced model policy per plan §Model policy.
  forceModel: process.env.FORCE_MODEL ?? 'opus',
  forceEffort: process.env.FORCE_EFFORT ?? 'xhigh',

  // Session pool sizing.
  poolSize: parseInt(process.env.BRIDGE_POOL_SIZE ?? '3', 10),
  concurrency: parseInt(process.env.BRIDGE_CONCURRENCY ?? '3', 10),

  // Session lifecycle thresholds.
  maxTurnsPerSession: parseInt(process.env.BRIDGE_MAX_TURNS ?? '50', 10),
  maxCacheTokens: parseInt(process.env.BRIDGE_MAX_CACHE_TOKENS ?? '160000', 10),
  requestTimeoutMs: parseInt(process.env.BRIDGE_REQUEST_TIMEOUT_MS ?? '180000', 10),

  // tmpfs budget for image payloads (bytes).
  tmpBudget: parseInt(process.env.BRIDGE_TMP_BUDGET ?? `${100 * 1024 * 1024}`, 10),
  tmpDir: process.env.BRIDGE_TMP_DIR ?? '/tmp/claude-bridge',

  // Where claude subprocesses run. Plain dir with no CLAUDE.md = clean behavior.
  workdir: process.env.CLAUDE_CODE_WORKDIR ?? '/tmp/claude-bridge/workdir',

  // Claude binary — resolve from local node_modules if present, else PATH.
  // `render-api/package.json` installs `@anthropic-ai/claude-code` as a local
  // dep, so on Railway the CLI is at render-api/node_modules/.bin/claude.
  claudeBin: process.env.CLAUDE_BIN ?? 'claude',
};

