/**
 * di/container.ts —— 轻量自建 DI 容器。
 *
 * 设计约束（来自任务书的架构强制要求）：
 *   - 每个能力定义接口，具体实现经**构造函数注入**；
 *   - **禁止**模块级单例、禁止跨模块直接 import 具体实现、禁止隐式全局状态；
 *   - 测试里可替换任一依赖。
 *
 * 容器只做三件事：登记工厂、按需解析（单例语义）、检测循环依赖。
 * 不做自动装配/魔法发现——装配是组合根的显式职责，可审查。
 */

import type { Token } from './tokens.js';

export class DependencyResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DependencyResolutionError';
  }
}

export class Container {
  private readonly factories = new Map<string, (c: Container) => unknown>();
  private readonly instances = new Map<string, unknown>();
  private readonly resolving: string[] = [];

  /** 登记一个**每次解析都新建**的工厂（适合持有请求级状态的对象）。 */
  register<T>(token: Token<T>, factory: (c: Container) => T): this {
    this.factories.set(token.key, factory as (c: Container) => unknown);
    return this;
  }

  /** 登记一个**单例**工厂（首次解析后缓存）。 */
  registerSingleton<T>(token: Token<T>, factory: (c: Container) => T): this {
    return this.register(token, (c) => {
      if (!this.instances.has(token.key)) {
        this.instances.set(token.key, factory(c));
      }
      return this.instances.get(token.key);
    });
  }

  /** 直接登记一个已构造好的值（测试里替换依赖用）。 */
  registerValue<T>(token: Token<T>, value: T): this {
    this.instances.set(token.key, value);
    this.factories.set(token.key, () => value);
    return this;
  }

  has(token: Token<unknown>): boolean {
    return this.factories.has(token.key);
  }

  resolve<T>(token: Token<T>): T {
    if (this.instances.has(token.key) && !this.factories.has(token.key)) {
      return this.instances.get(token.key) as T;
    }
    const factory = this.factories.get(token.key);
    if (factory === undefined) {
      throw new DependencyResolutionError(
        `未登记的依赖: ${token.key}。请在组合根 registerSingleton/register，或用 registerValue 注入测试替身。`,
      );
    }
    if (this.resolving.includes(token.key)) {
      throw new DependencyResolutionError(
        `循环依赖: ${[...this.resolving, token.key].join(' -> ')}`,
      );
    }
    this.resolving.push(token.key);
    try {
      return factory(this) as T;
    } finally {
      this.resolving.pop();
    }
  }

  /**
   * 派生一个子容器：继承父的全部登记，但之后对子容器的 register 不影响父。
   * 测试里用它做「整体替换一个依赖」而不污染其他用例。
   */
  createChild(): Container {
    const child = new Container();
    for (const [key, factory] of this.factories) {
      child.factories.set(key, factory);
    }
    for (const [key, value] of this.instances) {
      child.instances.set(key, value);
    }
    return child;
  }
}
