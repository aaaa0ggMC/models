import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createHttpServer, type DisconnectPolicyConfig } from '../http/server.js';
import type { PipelineRunner } from '../gateway-core/pipeline/runner.js';
import type { Authenticator } from '../gateway-core/pipeline/stages/s0-ingress.js';
import type { PipelineInput, PipelineOutcome } from '../gateway-core/pipeline/types.js';

const ALLOW_ALL_AUTH: Authenticator = {
  async authenticate() {
    return {
      ok: true,
      context: { key_id: 'vk_test', key_prefix: 'vk_test' },
    };
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('HTTP server client disconnect policy', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  async function setup(
    policy: DisconnectPolicyConfig,
    onRun: (input: PipelineInput) => Promise<void>,
  ): Promise<string> {
    const runner = {
      async run(input: PipelineInput): Promise<PipelineOutcome> {
        await onRun(input);
        return { ok: true } as PipelineOutcome;
      },
    } as unknown as PipelineRunner;

    server = createHttpServer({
      port: 0,
      host: '127.0.0.1',
      runner,
      authenticator: ALLOW_ALL_AUTH,
      disconnectPolicy: () => policy,
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('unexpected address');
    return `http://127.0.0.1:${addr.port}`;
  }

  it('aborts signal immediately when mode is immediate', async () => {
    let observedSignal: AbortSignal | undefined;
    let releaseRunner!: () => void;
    const runnerDone = new Promise<void>((r) => {
      releaseRunner = r;
    });
    let started!: () => void;
    const runnerStarted = new Promise<void>((r) => {
      started = r;
    });

    const base = await setup({ mode: 'immediate' }, async (input) => {
      observedSignal = input.abort_signal;
      started();
      await runnerDone;
    });

    const ac = new AbortController();
    const reqPromise = fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      body: '{}',
      signal: ac.signal,
    }).catch(() => {});

    await runnerStarted;
    expect(observedSignal?.aborted).toBe(false);

    ac.abort();
    await reqPromise;
    await sleep(30);
    expect(observedSignal?.aborted).toBe(true);
    releaseRunner();
  });

  it('waits graceMs before aborting when mode is grace', async () => {
    let observedSignal: AbortSignal | undefined;
    let releaseRunner!: () => void;
    const runnerDone = new Promise<void>((r) => {
      releaseRunner = r;
    });
    let started!: () => void;
    const runnerStarted = new Promise<void>((r) => {
      started = r;
    });

    const base = await setup({ mode: 'grace', graceMs: 80 }, async (input) => {
      observedSignal = input.abort_signal;
      started();
      await runnerDone;
    });

    const ac = new AbortController();
    const reqPromise = fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      body: '{}',
      signal: ac.signal,
    }).catch(() => {});

    await runnerStarted;
    ac.abort();
    await reqPromise;

    await sleep(25);
    expect(observedSignal?.aborted).toBe(false);

    await sleep(90);
    expect(observedSignal?.aborted).toBe(true);
    releaseRunner();
  });

  it('does not abort signal when mode is ignore', async () => {
    let observedSignal: AbortSignal | undefined;
    let releaseRunner!: () => void;
    const runnerDone = new Promise<void>((r) => {
      releaseRunner = r;
    });
    let started!: () => void;
    const runnerStarted = new Promise<void>((r) => {
      started = r;
    });

    const base = await setup({ mode: 'ignore' }, async (input) => {
      observedSignal = input.abort_signal;
      started();
      await runnerDone;
    });

    const ac = new AbortController();
    const reqPromise = fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      body: '{}',
      signal: ac.signal,
    }).catch(() => {});

    await runnerStarted;
    ac.abort();
    await reqPromise;
    await sleep(40);
    expect(observedSignal?.aborted).toBe(false);
    releaseRunner();
  });
});
