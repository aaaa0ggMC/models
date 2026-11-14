/**
 * adaptors/registry.ts —— AdaptorRegistry 的内存实现。
 *
 * 集中登记 + 重复键即报错：一个 (FormatId, ModalityKind) 二元组最多一个实现
 * （40 §1.3）。报错而不是静默覆盖，是为了让"两个 adaptor 抢同一个键"在启动时就暴露。
 */

import type { Adaptor, AdaptorMeta, AdaptorRegistry } from './types.js';
import type { FormatId, ModalityKind } from '../ir/index.js';

export class DuplicateAdaptorError extends Error {
  constructor(format: FormatId, modality: ModalityKind) {
    super(`adaptor 重复注册: (${format}, ${modality})。一个二元组最多一个实现（40 §1.3）。`);
    this.name = 'DuplicateAdaptorError';
  }
}

export class InMemoryAdaptorRegistry implements AdaptorRegistry {
  private readonly adaptors = new Map<string, Adaptor>();
  private readonly metas = new Map<string, AdaptorMeta>();

  private static key(format: FormatId, modality: ModalityKind): string {
    return `${format}::${modality}`;
  }

  register(adaptor: Adaptor, meta: AdaptorMeta): void {
    const key = InMemoryAdaptorRegistry.key(adaptor.format, meta.modality);
    if (this.adaptors.has(key)) {
      throw new DuplicateAdaptorError(adaptor.format, meta.modality);
    }
    this.adaptors.set(key, adaptor);
    this.metas.set(key, meta);
  }

  get(format: FormatId, modality: ModalityKind): Adaptor {
    const found = this.find(format, modality);
    if (found === undefined) {
      throw new Error(
        `未注册的 adaptor: (${format}, ${modality})。adaptor 按需写（40 §1.0），` +
          '缺失说明该 (格式, 模态) 组合尚未实现——路由应拒绝而不是落到别的 provider。',
      );
    }
    return found;
  }

  find(format: FormatId, modality: ModalityKind): Adaptor | undefined {
    return this.adaptors.get(InMemoryAdaptorRegistry.key(format, modality));
  }

  meta(format: FormatId, modality: ModalityKind): AdaptorMeta | undefined {
    return this.metas.get(InMemoryAdaptorRegistry.key(format, modality));
  }

  list(modality?: ModalityKind): AdaptorMeta[] {
    const all = [...this.metas.values()];
    return modality === undefined ? all : all.filter((m) => m.modality === modality);
  }
}
