/**
 * Layer 6 — API lifecycle (RED until Phase 2 + index.ts /assets static serve).
 *
 * With localInferenceConfig.enabled=true, fire each route in sequence:
 *   POST /generate-images       -> response.imageUrl  matches localhost:3000/assets/images/<uuid>.png
 *   POST /generate-audio        -> response.audioUrl  matches localhost:3000/assets/audio/<uuid>.wav
 *   POST /generate-video-clips  -> response.clipUrl   matches localhost:3000/assets/clips/<uuid>.mp4
 *   POST /render-video          -> response.videoUrl  matches localhost:3000/assets/renders/<id>-<uuid>.mp4
 *
 * Then GET /assets/<...> for each URL returns 200 with the right Content-Type.
 * Each step uses data from the previous step.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { http, HttpResponse } from 'msw';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { server } from '../setup';
import { samplePngBytes, sampleWavBytes, sampleMp4Bytes } from '../helpers/fixtures';
import { testProjectId } from '../helpers/factories';

let tmpAssetsDir: string;

const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

describe('Layer 6 — Local-mode API lifecycle (sequential)', () => {
  beforeAll(async () => {
    tmpAssetsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lifecycle-assets-'));
    for (const k of ['images', 'audio', 'clips', 'renders', 'thumbnails', 'fx']) {
      await fs.mkdir(path.join(tmpAssetsDir, k), { recursive: true });
    }
  });

  afterAll(async () => {
    await fs.rm(tmpAssetsDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('LOCAL_INFERENCE', 'true');
    vi.stubEnv('LOCAL_VOXCPM2_URL', 'http://localhost:7861');
    vi.stubEnv('LOCAL_ZIMAGE_URL', 'http://localhost:7862');
    vi.stubEnv('LOCAL_LTX2_URL', 'http://localhost:7863');
    vi.stubEnv('LOCAL_ASSETS_DIR', tmpAssetsDir);
    vi.stubEnv('LOCAL_ASSETS_BASE_URL', 'http://localhost:3000/assets');

    server.use(
      http.post('http://localhost:7862/generate', () =>
        HttpResponse.arrayBuffer(samplePngBytes(), { headers: { 'Content-Type': 'image/png' } }),
      ),
      http.post('http://localhost:7861/tts', () =>
        HttpResponse.arrayBuffer(sampleWavBytes(), { headers: { 'Content-Type': 'audio/wav' } }),
      ),
      http.post('http://localhost:7863/i2v', () =>
        HttpResponse.arrayBuffer(sampleMp4Bytes(), { headers: { 'Content-Type': 'video/mp4' } }),
      ),
      http.post('http://localhost:786(1|2|3)/unload' as any, () => HttpResponse.json({ ok: true })),
    );
  });

  it('runs the full sequence and serves /assets/* for each artifact', async () => {
    const { app } = await import('../../src/index');
    const projectId = testProjectId();

    // 1) Images
    const imagesRes = await request(app)
      .post('/generate-images')
      .send({ projectId, prompts: ['lifecycle prompt'] });
    expect(imagesRes.status).toBe(200);
    const imageUrl: string = imagesRes.body.images?.[0];
    expect(imageUrl).toMatch(new RegExp(`^http://localhost:3000/assets/images/${UUID_RE}\\.png$`));

    // 2) Audio
    const audioRes = await request(app)
      .post('/generate-audio')
      .send({ projectId, text: 'lifecycle text' });
    expect(audioRes.status).toBe(200);
    const audioUrl: string = audioRes.body.audioUrl;
    expect(audioUrl).toMatch(new RegExp(`^http://localhost:3000/assets/audio/${UUID_RE}\\.wav$`));

    // 3) Clips
    const clipsRes = await request(app)
      .post('/generate-video-clips')
      .send({ projectId, clips: [{ index: 0, imageUrl, prompt: 'pan' }] });
    expect(clipsRes.status).toBe(200);
    const clipUrl: string = clipsRes.body.clips?.[0]?.clipUrl ?? clipsRes.body.clipUrl;
    expect(clipUrl).toMatch(new RegExp(`^http://localhost:3000/assets/clips/${UUID_RE}\\.mp4$`));

    // 4) Render
    const renderRes = await request(app)
      .post('/render-video')
      .send({ projectId, images: [imageUrl], audioUrl, title: 'Lifecycle' });
    expect(renderRes.status).toBe(200);
    const videoUrl: string = renderRes.body.videoUrl;
    expect(videoUrl).toMatch(
      new RegExp(`^http://localhost:3000/assets/renders/[^/]+-${UUID_RE}\\.mp4$`),
    );

    // 5) Static serve: GET /assets/<...> for each
    const fetchPath = (url: string) => url.replace('http://localhost:3000', '');

    const imageGet = await request(app).get(fetchPath(imageUrl));
    expect(imageGet.status).toBe(200);
    expect(imageGet.headers['content-type']).toMatch(/^image\/png/);

    const audioGet = await request(app).get(fetchPath(audioUrl));
    expect(audioGet.status).toBe(200);
    expect(audioGet.headers['content-type']).toMatch(/^audio\/(wav|x-wav)/);

    const clipGet = await request(app).get(fetchPath(clipUrl));
    expect(clipGet.status).toBe(200);
    expect(clipGet.headers['content-type']).toMatch(/^video\/mp4/);

    const renderGet = await request(app).get(fetchPath(videoUrl));
    expect(renderGet.status).toBe(200);
    expect(renderGet.headers['content-type']).toMatch(/^video\/mp4/);
  });
});
