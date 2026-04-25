/**
 * Layer 4 — cost-tracker unit tests (RED until Phase 2 cost-tracker branch).
 *
 * Verifies that in local mode the rates for z_image / seedance / voxcpm2 /
 * fish_speech are 0 and remain unchanged in remote mode.
 *
 * NOTE: tests do NOT hard-code numeric assertions like 0.0084 (per ZG round 1
 * closure). They read from the rate map dynamically and compare relative behavior.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const LOCAL_FREE_SERVICES = ['z_image', 'seedance', 'voxcpm2', 'fish_speech'] as const;
const REMOTE_PAID_SERVICES = ['claude_input', 'claude_output', 'whisper'] as const;

describe('Layer 4 — PRICING in local mode', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it.each(LOCAL_FREE_SERVICES)(
    'sets %s rate to 0 when LOCAL_INFERENCE=true',
    async (service) => {
      vi.stubEnv('LOCAL_INFERENCE', 'true');
      const { PRICING } = await import('./cost-tracker');
      expect((PRICING as any)[service]).toBe(0);
    },
  );

  it.each(LOCAL_FREE_SERVICES)(
    'preserves %s rate (>0) when LOCAL_INFERENCE is unset',
    async (service) => {
      vi.stubEnv('LOCAL_INFERENCE', '');
      const { PRICING } = await import('./cost-tracker');
      expect((PRICING as any)[service]).toBeGreaterThan(0);
    },
  );

  it.each(REMOTE_PAID_SERVICES)(
    'leaves %s rate unchanged regardless of LOCAL_INFERENCE',
    async (service) => {
      vi.stubEnv('LOCAL_INFERENCE', '');
      const { PRICING: remote } = await import('./cost-tracker');
      const remoteRate = (remote as any)[service];

      vi.resetModules();
      vi.stubEnv('LOCAL_INFERENCE', 'true');
      const { PRICING: local } = await import('./cost-tracker');
      const localRate = (local as any)[service];

      expect(localRate).toBe(remoteRate);
      expect(localRate).toBeGreaterThan(0);
    },
  );
});

describe('Layer 4 — saveCost behavior in local mode', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it.each(LOCAL_FREE_SERVICES)(
    'computes total_cost=0 for %s in local mode',
    async (service) => {
      vi.stubEnv('LOCAL_INFERENCE', 'true');

      // Stub Supabase so saveCost does not actually hit the network
      const insert = vi.fn().mockResolvedValue({ error: null });
      const from = vi.fn(() => ({ insert }));
      vi.doMock('@supabase/supabase-js', () => ({
        createClient: () => ({ from }),
      }));
      vi.stubEnv('SUPABASE_URL', 'http://localhost');
      vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test');

      const { saveCost } = await import('./cost-tracker');
      const total = await saveCost({
        projectId: 'test-proj',
        source: 'manual',
        step: 'test_step',
        service,
        units: 5,
        unitType: 'units',
      });

      expect(total).toBe(0);
      expect(insert).toHaveBeenCalledWith(
        expect.objectContaining({ service, total_cost: 0, unit_cost: 0 }),
      );
    },
  );
});
