import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { setupServer } from 'msw/node';

// -----------------------------------------------------------------------------
// Env stubs — required for `await import('../../src/index')` to succeed.
//
// At module-load time, src/lib/content-moderator.ts (line 41) calls
// `createAnthropicClient()`, which throws `ANTHROPIC_API_KEY not configured`
// when the env var is empty. Several other modules also read env at top level:
//
//   - lib/anthropic-client.ts  → ANTHROPIC_API_KEY
//   - lib/cost-tracker.ts      → SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (lazy,
//                                only throws on first use; safe to leave unset
//                                but stubbed for completeness)
//   - lib/r2-storage.ts        → R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
//                                R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME (uses
//                                empty-string fallbacks; S3Client constructed
//                                eagerly but doesn't network until used)
//
// Stubbed values are obvious fakes — never resemble real credentials.
// Tests that need to override these (e.g. enableLocalMode) restub via
// `vi.stubEnv` per-test.
// -----------------------------------------------------------------------------
vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-real');
vi.stubEnv('OPENAI_API_KEY', 'test-key-not-real');
vi.stubEnv('SUPABASE_URL', 'https://test.supabase.co');
vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-key-not-real');
vi.stubEnv('R2_ACCOUNT_ID', 'test');
vi.stubEnv('R2_ACCESS_KEY_ID', 'test');
vi.stubEnv('R2_SECRET_ACCESS_KEY', 'test');
vi.stubEnv('R2_BUCKET_NAME', 'test-bucket');
vi.stubEnv('INTERNAL_API_KEY', 'test-internal-key');

export const server = setupServer();

// supertest binds the app to an ephemeral 127.0.0.1 port and makes a real
// HTTP request to it; with `onUnhandledRequest: 'error'` MSW would error out
// on these. Bypass localhost (any port) so supertest works while still erroring
// on unhandled requests to the local-inference URLs the tests are about.
beforeAll(() =>
  server.listen({
    onUnhandledRequest: (req, print) => {
      const { hostname } = new URL(req.url);
      if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1') {
        return; // bypass — supertest's own loopback request
      }
      print.error();
    },
  }),
);
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
