/**
 * Layer 5 — Regression snapshots (RED until Phase 2 callsites updated).
 *
 * With localInferenceConfig.enabled=false (LOCAL_INFERENCE unset), each modified
 * route's outgoing wire payload (to RunPod / Kie.ai / R2) must be byte-identical
 * to a captured baseline. We snapshot URL + method + headers + body per outbound
 * call.
 *
 * IMPORTANT
 *  - First run captures the baseline to tests/regression/__snapshots__/.
 *  - Second run validates against the baseline.
 *  - Do NOT delete or update files in __snapshots__/ blindly — investigate any
 *    drift; that is the whole point of this layer.
 *
 * Volatile values (UUIDs, timestamps) are stripped before snapshot.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { http, HttpResponse } from 'msw';

import { server } from '../setup';

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function strip(s: string): string {
  return s
    // strip UUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    // strip ISO timestamps
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<ts>')
    // strip Unix epoch ms
    .replace(/"timestamp"\s*:\s*\d{10,}/g, '"timestamp":<epoch>');
}

function snapshot(c: CapturedCall): string {
  const headerKeys = Object.keys(c.headers).sort().filter(k => !['authorization', 'x-api-key', 'date', 'host', 'user-agent', 'content-length'].includes(k.toLowerCase()));
  const headerLines = headerKeys.map(k => `${k.toLowerCase()}: ${strip(c.headers[k])}`).join('\n');
  return `${c.method} ${strip(c.url)}\n${headerLines}\n\n${strip(c.body)}`;
}

describe('Layer 5 — Remote-mode payload snapshots (LOCAL_INFERENCE=false)', () => {
  let captured: CapturedCall[] = [];

  beforeEach(() => {
    captured = [];
    vi.unstubAllEnvs();
    vi.stubEnv('LOCAL_INFERENCE', '');
    vi.stubEnv('NODE_ENV', 'test');
  });

  it('POST /generate-images outgoing payload to RunPod is unchanged', async () => {
    server.use(
      http.post('https://api.runpod.ai/*', async ({ request: req }) => {
        const body = await req.text();
        captured.push({
          url: req.url,
          method: req.method,
          headers: Object.fromEntries(req.headers.entries()),
          body,
        });
        return HttpResponse.json({ id: 'job-uuid', status: 'IN_QUEUE' });
      }),
    );
    const { app } = await import('../../src/index');
    await request(app)
      .post('/generate-images')
      .send({ projectId: 'snap-proj', prompts: ['snapshot prompt'] });

    expect(captured.length).toBeGreaterThan(0);
    expect(snapshot(captured[0])).toMatchSnapshot();
  });

  it('POST /generate-audio outgoing payload to RunPod is unchanged', async () => {
    server.use(
      http.post('https://api.runpod.ai/*', async ({ request: req }) => {
        const body = await req.text();
        captured.push({
          url: req.url,
          method: req.method,
          headers: Object.fromEntries(req.headers.entries()),
          body,
        });
        return HttpResponse.json({ id: 'job-uuid', status: 'IN_QUEUE' });
      }),
    );
    const { app } = await import('../../src/index');
    await request(app)
      .post('/generate-audio')
      .send({ projectId: 'snap-proj', text: 'snapshot audio text', voiceId: 'default' });

    expect(captured.length).toBeGreaterThan(0);
    expect(snapshot(captured[0])).toMatchSnapshot();
  });

  it('POST /generate-video-clips outgoing payload to Kie.ai is unchanged', async () => {
    server.use(
      http.post('https://api.kie.ai/api/v1/jobs/createTask', async ({ request: req }) => {
        const body = await req.text();
        captured.push({
          url: req.url,
          method: req.method,
          headers: Object.fromEntries(req.headers.entries()),
          body,
        });
        return HttpResponse.json({ taskId: 'task-uuid' });
      }),
    );
    const { app } = await import('../../src/index');
    await request(app)
      .post('/generate-video-clips')
      .send({
        projectId: 'snap-proj',
        clips: [{ index: 0, imageUrl: 'https://example.com/x.png', prompt: 'snapshot motion' }],
      });

    expect(captured.length).toBeGreaterThan(0);
    expect(snapshot(captured[0])).toMatchSnapshot();
  });

  it('R2 upload PutObjectCommand shape is unchanged', async () => {
    // R2 uses S3-compatible endpoint at <accountId>.r2.cloudflarestorage.com
    server.use(
      http.put('https://*.r2.cloudflarestorage.com/*', async ({ request: req }) => {
        const body = await req.text();
        captured.push({
          url: req.url.replace(/^https:\/\/[^.]+\./, 'https://<account>.'),
          method: req.method,
          headers: Object.fromEntries(req.headers.entries()),
          body: body.length > 256 ? `<bytes:${body.length}>` : body,
        });
        return new HttpResponse(null, { status: 200 });
      }),
    );

    const { uploadAsset } = await import('../../src/lib/r2-storage');
    await uploadAsset('audio', 'snap-key.wav', Buffer.from('fake-bytes'), 'audio/wav');

    expect(captured.length).toBeGreaterThan(0);
    expect(snapshot(captured[0])).toMatchSnapshot();
  });
});
