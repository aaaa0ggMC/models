import { describe, expect, it, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { createHttpServer, type StealthGateConfig } from '../http/server.js';
import type { PipelineRunner } from '../gateway-core/pipeline/runner.js';

describe('HTTP server stealth gate', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  async function startTestServer(getGate: () => StealthGateConfig): Promise<string> {
    const dummyRunner = {} as PipelineRunner;
    server = createHttpServer({
      port: 0,
      host: '127.0.0.1',
      runner: dummyRunner,
      stealthGate: getGate,
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('unexpected address');
    return `http://127.0.0.1:${addr.port}`;
  }

  it('allows data-plane requests through when stealth mode is disabled', async () => {
    const base = await startTestServer(() => ({
      enabled: false,
      key: 'gw_gate_secret',
      headerName: 'x-gateway-key',
    }));
    const res = await fetch(`${base}/v1/models`);
    // 到达数据面鉴权（未注入 authenticator 返回 401，而非 404）
    expect(res.status).toBe(401);
  });

  it('returns 404 when stealth mode is enabled and key is missing or wrong', async () => {
    const base = await startTestServer(() => ({
      enabled: true,
      key: 'gw_gate_secret',
      headerName: 'x-gateway-key',
    }));

    const missingRes = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}' });
    expect(missingRes.status).toBe(404);
    expect(await missingRes.text()).toBe('Not Found');

    const wrongRes = await fetch(`${base}/v1/models`, {
      headers: { 'x-gateway-key': 'wrong_key' },
    });
    expect(wrongRes.status).toBe(404);

    // 健康检查仍然放行
    const healthRes = await fetch(`${base}/health`);
    expect(healthRes.status).toBe(200);
  });

  it('passes through when valid stealth key is provided via header or query', async () => {
    let currentKey = 'gw_gate_v1';
    const base = await startTestServer(() => ({
      enabled: true,
      key: currentKey,
      headerName: 'X-Custom-Gate',
    }));

    const headerRes = await fetch(`${base}/v1/models`, {
      headers: { 'x-custom-gate': 'gw_gate_v1' },
    });
    expect(headerRes.status).toBe(401);

    const queryRes = await fetch(`${base}/v1/models?gate_key=gw_gate_v1`);
    expect(queryRes.status).toBe(401);

    // 密钥轮换后旧密钥立即失效，新密钥立即生效
    currentKey = 'gw_gate_v2';
    const oldRes = await fetch(`${base}/v1/models`, {
      headers: { 'x-custom-gate': 'gw_gate_v1' },
    });
    expect(oldRes.status).toBe(404);

    const newRes = await fetch(`${base}/v1/models`, {
      headers: { 'x-custom-gate': 'gw_gate_v2' },
    });
    expect(newRes.status).toBe(401);
  });
});
