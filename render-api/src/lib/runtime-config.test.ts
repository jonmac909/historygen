/**
 * Layer 4 — runtime-config unit tests (RED until Phase 2 step 1).
 *
 * Verifies that localInferenceConfig is exported from runtime-config.ts and
 * parses env vars into the locked-name shape. The new export does not exist
 * yet; this test fails today on import.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('Layer 4 — localInferenceConfig', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('exports localInferenceConfig with .enabled=false by default', async () => {
    vi.stubEnv('LOCAL_INFERENCE', '');
    const { localInferenceConfig } = await import('./runtime-config');
    expect(localInferenceConfig).toBeDefined();
    expect(localInferenceConfig.enabled).toBe(false);
  });

  it('parses LOCAL_INFERENCE=true into .enabled=true', async () => {
    vi.stubEnv('LOCAL_INFERENCE', 'true');
    const { localInferenceConfig } = await import('./runtime-config');
    expect(localInferenceConfig.enabled).toBe(true);
  });

  it('reads voxcpm2Url / zimageUrl / ltx2Url from env', async () => {
    vi.stubEnv('LOCAL_INFERENCE', 'true');
    vi.stubEnv('LOCAL_VOXCPM2_URL', 'http://localhost:7861');
    vi.stubEnv('LOCAL_ZIMAGE_URL', 'http://localhost:7862');
    vi.stubEnv('LOCAL_LTX2_URL', 'http://localhost:7863');
    const { localInferenceConfig } = await import('./runtime-config');
    expect(localInferenceConfig.voxcpm2Url).toBe('http://localhost:7861');
    expect(localInferenceConfig.zimageUrl).toBe('http://localhost:7862');
    expect(localInferenceConfig.ltx2Url).toBe('http://localhost:7863');
  });

  it('reads assetsDir / assetsBaseUrl / ffmpegPath from env', async () => {
    vi.stubEnv('LOCAL_INFERENCE', 'true');
    vi.stubEnv('LOCAL_ASSETS_DIR', 'D:\\historygen\\local-assets');
    vi.stubEnv('LOCAL_ASSETS_BASE_URL', 'http://localhost:3000/assets');
    vi.stubEnv('FFMPEG_PATH', 'C:\\ffmpeg\\bin\\ffmpeg.exe');
    const { localInferenceConfig } = await import('./runtime-config');
    expect(localInferenceConfig.assetsDir).toBe('D:\\historygen\\local-assets');
    expect(localInferenceConfig.assetsBaseUrl).toBe('http://localhost:3000/assets');
    expect(localInferenceConfig.ffmpegPath).toBe('C:\\ffmpeg\\bin\\ffmpeg.exe');
  });

  it('reads voxcpm2TimeoutMs / zimageTimeoutMs / ltx2TimeoutMs with safe defaults', async () => {
    vi.stubEnv('LOCAL_INFERENCE', 'true');
    const { localInferenceConfig } = await import('./runtime-config');
    expect(typeof localInferenceConfig.voxcpm2TimeoutMs).toBe('number');
    expect(typeof localInferenceConfig.zimageTimeoutMs).toBe('number');
    expect(typeof localInferenceConfig.ltx2TimeoutMs).toBe('number');
    // Defaults from plan: 60s / 5min / 15min
    expect(localInferenceConfig.voxcpm2TimeoutMs).toBeGreaterThan(0);
    expect(localInferenceConfig.zimageTimeoutMs).toBeGreaterThan(0);
    expect(localInferenceConfig.ltx2TimeoutMs).toBeGreaterThan(0);
  });

  it('overrides timeouts from env vars', async () => {
    vi.stubEnv('LOCAL_INFERENCE', 'true');
    vi.stubEnv('VOXCPM2_TIMEOUT_MS', '90000');
    vi.stubEnv('ZIMAGE_TIMEOUT_MS', '600000');
    vi.stubEnv('LTX2_TIMEOUT_MS', '1800000');
    const { localInferenceConfig } = await import('./runtime-config');
    expect(localInferenceConfig.voxcpm2TimeoutMs).toBe(90000);
    expect(localInferenceConfig.zimageTimeoutMs).toBe(600000);
    expect(localInferenceConfig.ltx2TimeoutMs).toBe(1800000);
  });

  it('does NOT mutate existing exports (corsAllowedOrigins, internalApiKey, imageGenerationConfig)', async () => {
    vi.stubEnv('LOCAL_INFERENCE', 'true');
    const mod = await import('./runtime-config');
    expect(mod.corsAllowedOrigins).toBeDefined();
    expect(mod.imageGenerationConfig).toBeDefined();
    expect(mod.imageGenerationConfig.maxConcurrentJobs).toBeTypeOf('number');
  });
});
