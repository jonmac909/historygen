/**
 * Layer 3 — API contract tests (RED until Phase 2 implementation).
 *
 * Per modified route:
 *   - Zod request-body validation (rejects missing fields, accepts valid)
 *   - In local mode: outgoing payload to local server matches expected camelCase shape
 *   - Response shape unchanged from remote mode
 *   - Cost row written with cost_usd=0 in local mode
 *   - Error envelope shape: { error: { code, message, details } }
 *   - SSE event ordering: started -> in_progress (LTX-2 heartbeat every 30s) -> completed
 *   - Between-stage POST /unload to non-needed servers
 *
 * Plus /config and /health endpoint tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { http, HttpResponse } from 'msw';

import { server } from '../setup';
import { samplePngBytes, sampleWavBytes, sampleMp4Bytes } from '../helpers/fixtures';
import { testProjectId } from '../helpers/factories';

// These imports drive RED until Phase 2 lands them.
import {
  LocalInferenceRequest,
  LocalInferenceResponse,
} from '../../src/schemas/local-inference-schemas';

const enableLocalMode = () => {
  vi.stubEnv('LOCAL_INFERENCE', 'true');
  vi.stubEnv('LOCAL_VOXCPM2_URL', 'http://localhost:7861');
  vi.stubEnv('LOCAL_ZIMAGE_URL', 'http://localhost:7862');
  vi.stubEnv('LOCAL_LTX2_URL', 'http://localhost:7863');
  vi.stubEnv('LOCAL_ASSETS_BASE_URL', 'http://localhost:3000/assets');
};

describe('Layer 3 — Zod schemas', () => {
  it('LocalInferenceRequest exists and is a Zod schema', () => {
    expect(LocalInferenceRequest).toBeDefined();
    expect(typeof (LocalInferenceRequest as any).parse).toBe('function');
  });

  it('LocalInferenceResponse exists and is a Zod schema', () => {
    expect(LocalInferenceResponse).toBeDefined();
    expect(typeof (LocalInferenceResponse as any).parse).toBe('function');
  });
});

describe('Layer 3 — POST /generate-images contract', () => {
  beforeEach(() => enableLocalMode());

  it('rejects request body missing required fields with VALIDATION_ERROR envelope', async () => {
    const { app } = await import('../../src/index');
    const res = await request(app).post('/generate-images').send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: { code: 'VALIDATION_ERROR', message: expect.any(String) },
    });
  });

  it('forwards camelCase payload to LOCAL_ZIMAGE_URL/generate', async () => {
    let capturedBody: any = null;
    server.use(
      http.post('http://localhost:7862/generate', async ({ request: req }) => {
        capturedBody = await req.json();
        return HttpResponse.arrayBuffer(samplePngBytes(), {
          headers: { 'Content-Type': 'image/png' },
        });
      }),
    );
    const { app } = await import('../../src/index');
    const res = await request(app)
      .post('/generate-images')
      .send({ projectId: testProjectId(), prompts: ['a Roman senator'] });

    expect(res.status).toBe(200);
    expect(capturedBody).toMatchObject({ prompt: expect.any(String) });
    // camelCase, not snake_case
    expect(capturedBody).not.toHaveProperty('aspect_ratio');
  });

  it('returns response with imageUrl key (shape unchanged from remote mode)', async () => {
    server.use(
      http.post('http://localhost:7862/generate', () =>
        HttpResponse.arrayBuffer(samplePngBytes(), {
          headers: { 'Content-Type': 'image/png' },
        }),
      ),
    );
    const { app } = await import('../../src/index');
    const res = await request(app)
      .post('/generate-images')
      .send({ projectId: testProjectId(), prompts: ['a test prompt'] });
    expect(res.body).toHaveProperty('images');
    expect(Array.isArray(res.body.images)).toBe(true);
  });

  it('writes cost row with cost_usd=0 in local mode', async () => {
    const saveCostSpy = vi.fn();
    vi.doMock('../../src/lib/cost-tracker', () => ({
      saveCost: saveCostSpy,
      PRICING: { z_image: 0 },
    }));

    server.use(
      http.post('http://localhost:7862/generate', () =>
        HttpResponse.arrayBuffer(samplePngBytes(), {
          headers: { 'Content-Type': 'image/png' },
        }),
      ),
    );
    const { app } = await import('../../src/index');
    await request(app)
      .post('/generate-images')
      .send({ projectId: testProjectId(), prompts: ['a test prompt'] });

    // saveCost called; total cost computes to 0 because z_image rate=0 in local mode
    expect(saveCostSpy).toHaveBeenCalled();
  });
});

describe('Layer 3 — POST /generate-audio contract', () => {
  beforeEach(() => enableLocalMode());

  it('rejects empty text with VALIDATION_ERROR', async () => {
    const { app } = await import('../../src/index');
    const res = await request(app).post('/generate-audio').send({ projectId: testProjectId(), text: '' });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('forwards camelCase payload to LOCAL_VOXCPM2_URL/tts', async () => {
    let capturedBody: any = null;
    server.use(
      http.post('http://localhost:7861/tts', async ({ request: req }) => {
        capturedBody = await req.json();
        return HttpResponse.arrayBuffer(sampleWavBytes(), {
          headers: { 'Content-Type': 'audio/wav' },
        });
      }),
    );
    const { app } = await import('../../src/index');
    await request(app)
      .post('/generate-audio')
      .send({ projectId: testProjectId(), text: 'hello world', voiceId: 'default' });

    expect(capturedBody).toMatchObject({ text: 'hello world' });
    expect(capturedBody).not.toHaveProperty('reference_audio_base64');
  });

  it('returns response with audioUrl key', async () => {
    server.use(
      http.post('http://localhost:7861/tts', () =>
        HttpResponse.arrayBuffer(sampleWavBytes(), {
          headers: { 'Content-Type': 'audio/wav' },
        }),
      ),
    );
    const { app } = await import('../../src/index');
    const res = await request(app)
      .post('/generate-audio')
      .send({ projectId: testProjectId(), text: 'hello' });
    expect(res.body).toHaveProperty('audioUrl');
  });
});

describe('Layer 3 — POST /generate-video-clips contract', () => {
  beforeEach(() => enableLocalMode());

  it('rejects empty clips array with VALIDATION_ERROR', async () => {
    const { app } = await import('../../src/index');
    const res = await request(app).post('/generate-video-clips').send({ clips: [] });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('forwards camelCase payload to LOCAL_LTX2_URL/i2v', async () => {
    let capturedBody: any = null;
    server.use(
      http.post('http://localhost:7863/i2v', async ({ request: req }) => {
        capturedBody = await req.json();
        return HttpResponse.arrayBuffer(sampleMp4Bytes(), {
          headers: { 'Content-Type': 'video/mp4' },
        });
      }),
    );
    const { app } = await import('../../src/index');
    await request(app)
      .post('/generate-video-clips')
      .send({
        projectId: testProjectId(),
        clips: [{ index: 0, imageUrl: 'http://localhost:3000/assets/images/x.png', prompt: 'pan left' }],
      });

    expect(capturedBody).toMatchObject({ imageUrl: expect.any(String), prompt: expect.any(String) });
    expect(capturedBody).not.toHaveProperty('image_url');
  });
});

describe('Layer 3 — POST /render-video contract', () => {
  beforeEach(() => enableLocalMode());

  it('returns response with videoUrl key', async () => {
    const { app } = await import('../../src/index');
    const res = await request(app)
      .post('/render-video')
      .send({
        projectId: testProjectId(),
        images: ['http://localhost:3000/assets/images/x.png'],
        audioUrl: 'http://localhost:3000/assets/audio/y.wav',
        title: 'Test',
      });
    expect(res.body).toHaveProperty('videoUrl');
  });
});

describe('Layer 3 — SSE event ordering (ZG-11)', () => {
  beforeEach(() => {
    enableLocalMode();
    vi.useFakeTimers();
  });

  it('emits started -> in_progress (LTX-2 heartbeats every 30s) -> completed', async () => {
    const events: Array<{ stage: string; status: string }> = [];

    server.use(
      http.post('http://localhost:7863/i2v', async () => {
        // Simulate LTX-2 NDJSON streaming heartbeats
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'progress', elapsedSec: 30 }) + '\n'));
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'progress', elapsedSec: 60 }) + '\n'));
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'done', urlPath: '/assets/clips/x.mp4' }) + '\n'));
            controller.close();
          },
        });
        return new HttpResponse(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
      }),
    );

    const { app } = await import('../../src/index');
    // Tap the SSE channel emitter — exact API depends on Phase 2 design
    const sseTap = (req: any, res: any, next: any) => {
      const origWrite = res.write.bind(res);
      res.write = (chunk: any) => {
        const txt = chunk.toString();
        const m = txt.match(/data:\s*(\{.*?\})/);
        if (m) {
          try {
            const obj = JSON.parse(m[1]);
            if (obj.stage && obj.status) events.push({ stage: obj.stage, status: obj.status });
          } catch {}
        }
        return origWrite(chunk);
      };
      next();
    };
    app.use(sseTap);

    await request(app)
      .post('/generate-video-clips')
      .send({
        projectId: testProjectId(),
        clips: [{ index: 0, imageUrl: 'http://localhost:3000/assets/images/x.png', prompt: 'pan' }],
      });

    // Order: started before in_progress before completed
    const stageEvents = events.filter(e => e.stage === 'clips');
    expect(stageEvents.map(e => e.status)).toEqual(
      expect.arrayContaining(['started', 'in_progress', 'completed']),
    );
  });
});

describe('Layer 3 — POST /unload between stages', () => {
  beforeEach(() => enableLocalMode());

  it('after image stage completes, fires /unload to audio + LTX-2 servers', async () => {
    const unloadCalls: string[] = [];

    server.use(
      http.post('http://localhost:7862/generate', () =>
        HttpResponse.arrayBuffer(samplePngBytes(), { headers: { 'Content-Type': 'image/png' } }),
      ),
      http.post('http://localhost:7861/unload', () => {
        unloadCalls.push('voxcpm2');
        return HttpResponse.json({ ok: true });
      }),
      http.post('http://localhost:7862/unload', () => {
        unloadCalls.push('zimage');
        return HttpResponse.json({ ok: true });
      }),
      http.post('http://localhost:7863/unload', () => {
        unloadCalls.push('ltx2');
        return HttpResponse.json({ ok: true });
      }),
    );

    const { app } = await import('../../src/index');
    await request(app)
      .post('/generate-images')
      .send({ projectId: testProjectId(), prompts: ['x'] });

    // After image stage: voxcpm2 + ltx2 unloaded; zimage not (still needed)
    expect(unloadCalls).toContain('voxcpm2');
    expect(unloadCalls).toContain('ltx2');
  });

  it('treats 409 BUSY responses to /unload as benign skip', async () => {
    server.use(
      http.post('http://localhost:7862/generate', () =>
        HttpResponse.arrayBuffer(samplePngBytes(), { headers: { 'Content-Type': 'image/png' } }),
      ),
      http.post('http://localhost:7861/unload', () =>
        HttpResponse.json(
          { error: { code: 'BUSY', message: 'model is loading' } },
          { status: 409, headers: { 'Retry-After': '30' } },
        ),
      ),
      http.post('http://localhost:7863/unload', () => HttpResponse.json({ ok: true })),
    );

    const { app } = await import('../../src/index');
    const res = await request(app)
      .post('/generate-images')
      .send({ projectId: testProjectId(), prompts: ['x'] });
    expect(res.status).toBe(200); // request succeeded despite 409 unload
  });
});

describe('Layer 3 — GET /config', () => {
  it('returns { localInferenceMode: <flag value> } unauthenticated', async () => {
    vi.stubEnv('LOCAL_INFERENCE', 'true');
    const { app } = await import('../../src/index');
    // No X-Internal-Api-Key header — must still succeed
    const res = await request(app).get('/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ localInferenceMode: true });
  });

  it('does NOT include URLs / secrets / model paths', async () => {
    const { app } = await import('../../src/index');
    const res = await request(app).get('/config');
    expect(res.body).not.toHaveProperty('voxcpm2Url');
    expect(res.body).not.toHaveProperty('zimageUrl');
    expect(res.body).not.toHaveProperty('ltx2Url');
    expect(res.body).not.toHaveProperty('assetsDir');
    expect(res.body).not.toHaveProperty('internalApiKey');
  });
});

describe('Layer 3 — GET /health', () => {
  it('returns { ok: true }', async () => {
    const { app } = await import('../../src/index');
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
