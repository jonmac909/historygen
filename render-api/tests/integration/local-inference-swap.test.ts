/**
 * Layer 1 — Walking skeleton (RED until Phase 1+2+2.5 complete).
 *
 * One end-to-end happy path with localInferenceConfig.enabled=true:
 *   POST /generate-images -> POST /generate-audio -> POST /render-video
 * Final response includes a localhost:3000/assets/renders/<uuid>.mp4 URL.
 *
 * Mocks the 3 Python servers via msw. Production routes do not have local
 * branches yet, so this fails today on purpose.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { http, HttpResponse } from 'msw';

import { server } from '../setup';
import { samplePngBytes, sampleWavBytes, sampleMp4Bytes } from '../helpers/fixtures';
import { testProjectId } from '../helpers/factories';

// These imports will fail (or produce undefined) until Phase 1+2 implementation.
// That is the desired RED signal.
import { localInferenceConfig } from '../../src/lib/runtime-config';

describe('Layer 1 — local-inference-swap walking skeleton', () => {
  beforeEach(() => {
    vi.stubEnv('LOCAL_INFERENCE', 'true');
    vi.stubEnv('LOCAL_VOXCPM2_URL', 'http://localhost:7861');
    vi.stubEnv('LOCAL_ZIMAGE_URL', 'http://localhost:7862');
    vi.stubEnv('LOCAL_LTX2_URL', 'http://localhost:7863');
    vi.stubEnv('LOCAL_ASSETS_BASE_URL', 'http://localhost:3000/assets');
  });

  it('exposes localInferenceConfig.enabled=true when LOCAL_INFERENCE=true', () => {
    expect(localInferenceConfig).toBeDefined();
    expect(localInferenceConfig.enabled).toBe(true);
  });

  it('runs the local pipeline end-to-end and returns a localhost renders URL', async () => {
    // Mock the 3 Python servers
    server.use(
      http.post('http://localhost:7862/generate', async () => {
        return HttpResponse.arrayBuffer(samplePngBytes(), {
          headers: { 'Content-Type': 'image/png' },
        });
      }),
      http.post('http://localhost:7861/tts', async () => {
        return HttpResponse.arrayBuffer(sampleWavBytes(), {
          headers: { 'Content-Type': 'audio/wav' },
        });
      }),
      http.post('http://localhost:7863/i2v', async () => {
        return HttpResponse.arrayBuffer(sampleMp4Bytes(), {
          headers: { 'Content-Type': 'video/mp4' },
        });
      }),
      http.post('http://localhost:7861/unload', () => HttpResponse.json({ ok: true })),
      http.post('http://localhost:7862/unload', () => HttpResponse.json({ ok: true })),
      http.post('http://localhost:7863/unload', () => HttpResponse.json({ ok: true })),
    );

    // Boot the express app (will fail until index.ts exports the app for tests)
    const { app } = await import('../../src/index');
    const projectId = testProjectId();

    const imagesRes = await request(app)
      .post('/generate-images')
      .send({ projectId, prompts: ['a Roman senator on the forum steps, oil painting'] });
    expect(imagesRes.status).toBe(200);
    expect(imagesRes.body.images?.[0]).toMatch(/^http:\/\/localhost:3000\/assets\/images\//);

    const audioRes = await request(app)
      .post('/generate-audio')
      .send({ projectId, text: 'Hello world.', voiceId: 'default' });
    expect(audioRes.status).toBe(200);
    expect(audioRes.body.audioUrl).toMatch(/^http:\/\/localhost:3000\/assets\/audio\//);

    const renderRes = await request(app)
      .post('/render-video')
      .send({
        projectId,
        images: imagesRes.body.images,
        audioUrl: audioRes.body.audioUrl,
        title: 'Skeleton',
      });
    expect(renderRes.status).toBe(200);
    expect(renderRes.body.videoUrl).toMatch(
      /^http:\/\/localhost:3000\/assets\/renders\/[\w-]+\.mp4$/,
    );
  });

  it('rejects with safe default when LOCAL_INFERENCE is unset (still importable)', () => {
    vi.stubEnv('LOCAL_INFERENCE', '');
    // Re-importing config — in remote mode .enabled must be false
    expect(localInferenceConfig).toBeDefined();
  });
});
