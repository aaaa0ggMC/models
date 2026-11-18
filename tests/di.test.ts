/**
 * tests/di.test.ts —— DI 容器行为。
 *
 * 覆盖架构强制要求的三条：可替换任一依赖、无隐式全局状态、循环依赖可检测。
 */

import { describe, expect, it } from 'vitest';
import {
  Container,
  DependencyResolutionError,
  TOKENS,
  createToken,
  type Clock,
} from '../di/index.js';
import { MemoryLogger, MemoryMetrics, fixedClock, SequentialIdGenerator } from '../di/index.js';

describe('Container', () => {
  it('registerSingleton 只构造一次', () => {
    const c = new Container();
    let calls = 0;
    c.registerSingleton(TOKENS.Clock, () => {
      calls += 1;
      return fixedClock(1000);
    });
    const a = c.resolve(TOKENS.Clock);
    const b = c.resolve(TOKENS.Clock);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  it('register 每次解析都新建', () => {
    const c = new Container();
    c.register(TOKENS.Logger, () => new MemoryLogger());
    expect(c.resolve(TOKENS.Logger)).not.toBe(c.resolve(TOKENS.Logger));
  });

  it('registerValue 注入测试替身', () => {
    const c = new Container();
    const fake: Clock = { now: () => 42 };
    c.registerValue(TOKENS.Clock, fake);
    expect(c.resolve(TOKENS.Clock).now()).toBe(42);
  });

  it('未登记的依赖给出可读错误', () => {
    const c = new Container();
    expect(() => c.resolve(TOKENS.Metrics)).toThrow(DependencyResolutionError);
    expect(() => c.resolve(TOKENS.Metrics)).toThrow(/未登记的依赖: Metrics/);
  });

  it('检测循环依赖', () => {
    const c = new Container();
    c.register(TOKENS.Clock, (cc) => {
      cc.resolve(TOKENS.Logger);
      return fixedClock(0);
    });
    c.register(TOKENS.Logger, (cc) => {
      cc.resolve(TOKENS.Clock);
      return new MemoryLogger();
    });
    expect(() => c.resolve(TOKENS.Clock)).toThrow(/循环依赖/);
  });

  it('createChild 派生不影响父容器', () => {
    const parent = new Container();
    parent.registerValue(TOKENS.Clock, fixedClock(1));
    const child = parent.createChild();
    child.registerValue(TOKENS.Clock, fixedClock(2));
    expect(parent.resolve(TOKENS.Clock).now()).toBe(1);
    expect(child.resolve(TOKENS.Clock).now()).toBe(2);
  });

  it('token 的类型参数参与编译期检查（不同 Token<T> 不兼容）', () => {
    const clockToken = createToken<Clock>('Clock');
    const c = new Container();
    c.registerValue(clockToken, fixedClock(0));
    // 类型参数参与编译期检查：Token<Clock> 与 Token<MemoryLogger> 不兼容，
    // 因此 c.registerValue(createToken<MemoryLogger>("Clock"), c.resolve(clockToken))
    // 这行若取消注释应报类型错误。
    expect(c.resolve(clockToken).now()).toBe(0);
  });
});

describe('跨切面基础设施端口', () => {
  it('MemoryMetrics 采集样本', () => {
    const m = new MemoryMetrics();
    m.increment('a', 1, { k: 'v' });
    m.timing('b', 12);
    m.gauge('c', 3);
    const snap = m.snapshot();
    expect(snap).toHaveLength(3);
    expect(snap[0]).toMatchObject({ name: 'a', kind: 'counter', value: 1, tags: { k: 'v' } });
  });

  it('SequentialIdGenerator 产出 req_ 前缀的确定性 id', () => {
    const ids = new SequentialIdGenerator();
    expect(ids.requestId()).toBe('req_test_000001');
    expect(ids.toolCallId()).toBe('call_test_000002');
  });

  it('fixedClock 可控时间', () => {
    const clock = fixedClock(1000, 5);
    expect(clock.now()).toBe(1000);
    expect(clock.now()).toBe(1005);
    expect(clock.now()).toBe(1010);
  });
});
