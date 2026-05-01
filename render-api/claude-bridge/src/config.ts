// Centralized bridge configuration. Every knob is an env var so the container
// can be retuned without a rebuild.

export const config = {
  host: '127.0.0.1', // loopback only — bridge must never be externally reachable
  port: parseInt(process.env.BRIDGE_PORT ?? '9001', 10),

  // Default model when the caller doesn't specify one.
  defaultModel: process.env.BRIDGE_DEFAULT_MODEL ?? 'opus',
  defaultEffort: process.env.BRIDGE_DEFAULT_EFFORT ?? 'high',

  // Session pool sizing.
  poolSize: parseInt(process.env.BRIDGE_POOL_SIZE ?? '3', 10),
  concurrency: parseInt(process.env.BRIDGE_CONCURRENCY ?? '3', 10),

  // Session lifecycle thresholds.
  maxTurnsPerSession: parseInt(process.env.BRIDGE_MAX_TURNS ?? '50', 10),
  maxCacheTokens: parseInt(process.env.BRIDGE_MAX_CACHE_TOKENS ?? '160000', 10),
  // Absolute max per turn (20 min). Hard ceiling as a safety guard; a
  // healthy turn almost always finishes well before this. Override per-env
  // via BRIDGE_REQUEST_TIMEOUT_MS.
  requestTimeoutMs: parseInt(process.env.BRIDGE_REQUEST_TIMEOUT_MS ?? '1200000', 10),

  // Idle (no-activity) timeout — how long the session can go silent before
  // we treat it as stuck. Any line from Claude's stdout (text delta, system
  // event, rate-limit event) resets this. Separates "slow but streaming"
  // from "actually hung".
  //
  // Default 10 min. Opus at xhigh effort buffers extended-thinking phases
  // silently on long-form tasks (20k-word script rewrites spent ~3 min
  // thinking with zero stdout before streaming began), so a tight 3-min
  // threshold caused false kills. 10 min still catches a truly hung
  // subprocess well before the 20-min absolute cap.
  idleTimeoutMs: parseInt(process.env.BRIDGE_IDLE_TIMEOUT_MS ?? '600000', 10),

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

