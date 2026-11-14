/**
 * credentials/capability-registry.ts —— 能力矩阵。
 *
 * 唯一事实来源：docs/design/45-credentials.md §6.2（新矩阵，键 = (access_path, model, modality)），
 * 字段合并在 ir/capability.ts 的注释里说明。
 *
 * 路由据此做三件事（25 §9）：**拒绝**（桥接不了）、**降级**（能桥接但有代价，写 meta.warnings）、
 * **放行**。矩阵三态必须诚实（40 §5：`planned` 只允许存在于当前 Phase 的交付物清单里）。
 */

import type { CapabilityEntry, ModalityKind } from '../ir/index.js';
import { capabilityKey } from '../ir/index.js';

export interface CapabilityRegistry {
  register(entry: CapabilityEntry): void;
  find(accessPath: string, model: string, modality: ModalityKind): CapabilityEntry | undefined;
  list(modality?: ModalityKind): CapabilityEntry[];
  /** 该 (access_path, model, modality) 是否已实现（三态里的 implemented）。 */
  isImplemented(accessPath: string, model: string, modality: ModalityKind): boolean;
}

export class InMemoryCapabilityRegistry implements CapabilityRegistry {
  private readonly entries = new Map<string, CapabilityEntry>();

  register(entry: CapabilityEntry): void {
    this.entries.set(capabilityKey(entry.access_path, entry.model, entry.modality), entry);
  }

  find(accessPath: string, model: string, modality: ModalityKind): CapabilityEntry | undefined {
    return this.entries.get(capabilityKey(accessPath, model, modality));
  }

  list(modality?: ModalityKind): CapabilityEntry[] {
    const all = [...this.entries.values()];
    return modality === undefined ? all : all.filter((e) => e.modality === modality);
  }

  isImplemented(accessPath: string, model: string, modality: ModalityKind): boolean {
    return this.find(accessPath, model, modality)?.status === 'implemented';
  }
}
