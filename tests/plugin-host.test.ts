/**
 * tests/plugin-host.test.ts —— 插件运行时的调度与故障隔离。
 *
 * 逐条覆盖 docs/design/30-plugin-api.md §3 的时序规则：
 *   - 同 hook 内多插件按 order 升序，前一个的输出是后一个的输入；
 *   - onRequest 返回 ShortCircuit → 后续 onRequest 不再执行，但 onResponse 仍执行；
 *   - 插件抛异常默认不阻断（记 metric + warning），fatal: true 时阻断；
 *   - onError 不改变控制流；
 *   - 注册期 manifest 校验（onStreamChunk + context_compaction 冲突）。
 */

import { describe, expect, it } from "vitest";
import type {
  CanonicalRequestEnvelope,
  CanonicalResponseEnvelope,
  CanonicalStreamEvent,
  Plugin,
  RequestContext,
} from "../ir/index.js";
import { DefaultPluginHost, PluginRegistrationError } from "../plugins/host.js";
import {
  MemoryLogger,
  MemoryMetrics,
  fixedClock,
} from "../di/index.js";
import { MutableRequestContext } from "../gateway-core/context.js";

function makeHost(timeoutMs = 1000) {
  return new DefaultPluginHost(
    {
      log: new MemoryLogger(),
      metrics: new MemoryMetrics(),
      clock: fixedClock(0),
      currentUsage: () => ({ units: {}, source: "provider" }),
      kv: { async get() {}, async set() {}, async delete() {} },
    },
    timeoutMs,
  );
}

function makeCtx(): RequestContext {
  return new MutableRequestContext({
    request_id: "req_test",
    started_at: 0,
    deadline: 1000,
    client_format: "openai.chat",
    client_raw_headers: {},
    auth: { key_id: "k" },
  });
}

function chatReq(text = "hi"): CanonicalRequestEnvelope {
  return {
    ir_version: "ag-ir/1",
    kind: "chat",
    model: "gpt-test-1",
    source_format: "openai.chat",
    raw: {},
    payload: {
      system: [],
      messages: [{ role: "user", parts: [{ type: "text", text }] }],
    },
  };
}

function chatRes(): CanonicalResponseEnvelope {
  return {
    ir_version: "ag-ir/1",
    kind: "chat",
    request_id: "req_test",
    usage: { units: {}, source: "provider" },
    finish_reason: "stop",
    payload: { message: { role: "assistant", parts: [{ type: "text", text: "ok" }] } },
    warnings: [],
    raw: {},
  };
}

describe("DefaultPluginHost 注册期校验", () => {
  it("重名插件报错", () => {
    const host = makeHost();
    const p: Plugin = { manifest: { name: "a", version: "1.0.0", hooks: ["onRequest"] } };
    host.register(p);
    expect(() => host.register(p)).toThrow(PluginRegistrationError);
  });

  it("hooks 为空报错", () => {
    const host = makeHost();
    expect(() =>
      host.register({ manifest: { name: "a", version: "1.0.0", hooks: [] } }),
    ).toThrow(/hooks 不能为空/);
  });

  it("onStreamChunk + context_compaction 冲突被拒绝（25 §7.3）", () => {
    const host = makeHost();
    expect(() =>
      host.register({
        manifest: {
          name: "bad",
          version: "1.0.0",
          hooks: ["onStreamChunk"],
          capabilities: ["context_compaction"],
        },
      }),
    ).toThrow(/不得声明 capabilities.context_compaction/);
  });
});

describe("onRequest 链", () => {
  it("按 order 升序，前一个的输出是后一个的输入", async () => {
    const host = makeHost();
    const seen: string[] = [];
    const mk = (name: string, order: number): Plugin => ({
      manifest: { name, version: "1.0.0", hooks: ["onRequest"], order },
      onRequest: (req) => {
        seen.push(name);
        const msg = req.payload.messages[0]!;
        const part = msg.parts[0]!;
        if (part.type === "text") part.text = `${part.text}+${name}`;
        return req;
      },
    });
    host.register(mk("second", 20));
    host.register(mk("first", 10));
    host.register(mk("third", 30));

    const out = await host.runOnRequest(chatReq("x"), makeCtx());
    expect(seen).toEqual(["first", "second", "third"]);
    if (typeof out === "object" && "payload" in out) {
      const part = out.payload.messages[0]!.parts[0]!;
      expect(part.type === "text" && part.text).toBe("x+first+second+third");
    }
  });

  it("返回 ShortCircuit 时后续 onRequest 不再执行", async () => {
    const host = makeHost();
    const ran: string[] = [];
    host.register({
      manifest: { name: "guard", version: "1.0.0", hooks: ["onRequest"], order: 10 },
      onRequest: () => {
        ran.push("guard");
        return { short_circuit: true, reason: "blocked", http_status: 403 };
      },
    });
    host.register({
      manifest: { name: "later", version: "1.0.0", hooks: ["onRequest"], order: 20 },
      onRequest: (req) => {
        ran.push("later");
        return req;
      },
    });
    const out = await host.runOnRequest(chatReq(), makeCtx());
    expect(ran).toEqual(["guard"]);
    expect(typeof out === "object" && "short_circuit" in out && out.short_circuit).toBe(true);
  });

  it("插件抛异常默认不阻断，记 warning", async () => {
    const host = makeHost();
    host.register({
      manifest: { name: "boom", version: "1.0.0", hooks: ["onRequest"] },
      onRequest: () => {
        throw new Error("boom");
      },
    });
    const ctx = makeCtx();
    const out = await host.runOnRequest(chatReq(), ctx);
    // 不改写：返回原请求
    expect(typeof out === "object" && "payload" in out).toBe(true);
    expect(ctx.warnings.some((w) => w.startsWith("plugin_error:boom"))).toBe(true);
  });

  it("fatal: true 的插件失败时阻断并给出 plugin_error", async () => {
    const host = makeHost();
    host.register({
      manifest: { name: "boom", version: "1.0.0", hooks: ["onRequest"], fatal: true },
      onRequest: () => {
        throw new Error("boom");
      },
    });
    const out = await host.runOnRequest(chatReq(), makeCtx());
    expect(typeof out === "object" && "short_circuit" in out && out.short_circuit).toBe(true);
    if (typeof out === "object" && "short_circuit" in out) {
      expect(out.error?.code).toBe("plugin_error");
    }
  });

  it("插件超时按失败处理（不阻断）", async () => {
    const host = makeHost(20);
    host.register({
      manifest: { name: "slow", version: "1.0.0", hooks: ["onRequest"], timeout_ms: 20 },
      onRequest: async (req) => {
        await new Promise((r) => setTimeout(r, 200));
        return req;
      },
    });
    const ctx = makeCtx();
    const out = await host.runOnRequest(chatReq(), ctx);
    expect(ctx.warnings.some((w) => w.includes("timeout"))).toBe(true);
    expect(typeof out === "object" && "payload" in out).toBe(true);
  });
});

describe("onStreamChunk 链", () => {
  const textEvent: CanonicalStreamEvent = {
    type: "part.delta",
    index: 0,
    delta: { type: "text", text: "hello" },
  };

  it("返回 null = 丢弃", async () => {
    const host = makeHost();
    host.register({
      manifest: { name: "drop", version: "1.0.0", hooks: ["onStreamChunk"] },
      onStreamChunk: () => null,
    });
    expect(await host.runOnStreamChunk(textEvent, makeCtx())).toBeNull();
  });

  it("返回数组 = 一帧变多帧", async () => {
    const host = makeHost();
    host.register({
      manifest: { name: "split", version: "1.0.0", hooks: ["onStreamChunk"] },
      onStreamChunk: (ev) => [ev, ev],
    });
    const out = await host.runOnStreamChunk(textEvent, makeCtx());
    expect(Array.isArray(out) && out.length).toBe(2);
  });

  it("插件失败时透传原事件", async () => {
    const host = makeHost();
    host.register({
      manifest: { name: "boom", version: "1.0.0", hooks: ["onStreamChunk"] },
      onStreamChunk: () => {
        throw new Error("boom");
      },
    });
    const out = await host.runOnStreamChunk(textEvent, makeCtx());
    expect(out).toEqual(textEvent);
  });
});

describe("onError 与 dispose", () => {
  it("onError 被广播且不改变控制流", async () => {
    const host = makeHost();
    const seen: string[] = [];
    host.register({
      manifest: { name: "obs", version: "1.0.0", hooks: ["onError"] },
      onError: (err) => {
        seen.push(err.code);
      },
    });
    await host.notifyError(
      {
        code: "upstream_error",
        message: "m",
        http_status: 502,
        retryable: true,
        request_id: "r",
      },
      makeCtx(),
    );
    expect(seen).toEqual(["upstream_error"]);
  });

  it("onError 插件抛异常不向上抛", async () => {
    const host = makeHost();
    host.register({
      manifest: { name: "boom", version: "1.0.0", hooks: ["onError"] },
      onError: () => {
        throw new Error("boom");
      },
    });
    await expect(
      host.notifyError(
        { code: "upstream_error", message: "m", http_status: 502, retryable: true, request_id: "r" },
        makeCtx(),
      ),
    ).resolves.toBeUndefined();
  });

  it("dispose 调用插件的 dispose 并清空注册表", async () => {
    const host = makeHost();
    let disposed = false;
    host.register({
      manifest: { name: "a", version: "1.0.0", hooks: ["onRequest"] },
      dispose: () => {
        disposed = true;
      },
    });
    await host.dispose();
    expect(disposed).toBe(true);
    expect(host.requestSide()).toHaveLength(0);
  });
});
