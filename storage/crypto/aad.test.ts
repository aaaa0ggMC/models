/**
 * storage/crypto/aad.test.ts —— AAD 统一写法。
 *
 * 覆盖：序列化格式、分隔符不可碰撞、kind/id 参与、版本参与、反解往返、
 * 非法输入拒绝。
 */

import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { buildAad, parseAad, type AadRecordKind } from './aad.js';

describe('buildAad', () => {
  it('格式为 kind + US + id + US + vN', () => {
    const aad = buildAad({ kind: 'credential', id: 'cred_deepseek_1' });
    expect(aad.toString('utf8')).toBe('credential\u001fcred_deepseek_1\u001fv1');
  });

  it('kind 不同 → AAD 不同', () => {
    const a = buildAad({ kind: 'credential', id: 'x' });
    const b = buildAad({ kind: 'alias', id: 'x' });
    expect(a.equals(b)).toBe(false);
  });

  it('id 不同 → AAD 不同', () => {
    const a = buildAad({ kind: 'credential', id: 'x' });
    const b = buildAad({ kind: 'credential', id: 'y' });
    expect(a.equals(b)).toBe(false);
  });

  it('version 不同 → AAD 不同（记录形状升级后旧密文拒绝被误读）', () => {
    const a = buildAad({ kind: 'credential', id: 'x', version: 1 });
    const b = buildAad({ kind: 'credential', id: 'x', version: 2 });
    expect(a.equals(b)).toBe(false);
  });

  it('id 含 "/" 也不会歧义（分隔符是 US 不是 "/"）', () => {
    // 若用 "/" 做分隔符，这两个会撞车：
    //   kind='a/b' id='c'   vs   kind='a' id='b/c'
    const a = buildAad({ kind: 'alias', id: 'deepseek/foo' });
    const b = buildAad({ kind: 'alias', id: 'deepseek' });
    expect(a.equals(b)).toBe(false);
    // 且反解能拿回原 id
    expect(parseAad(a).id).toBe('deepseek/foo');
  });

  it('反解往返', () => {
    const input = { kind: 'audit' as AadRecordKind, id: 'audit_123', version: 3 };
    expect(parseAad(buildAad(input))).toEqual(input);
  });

  it('空 id 被拒绝', () => {
    expect(() => buildAad({ kind: 'credential', id: '' })).toThrow(/id 不能为空/);
  });

  it('id 含分隔符被拒绝（宁可报错也不产出歧义 AAD）', () => {
    expect(() => buildAad({ kind: 'credential', id: 'a\u001fb' })).toThrow(/含分隔符/);
  });

  it('反解非三段输入报错', () => {
    expect(() => parseAad(Buffer.from('only-one-field', 'utf8'))).toThrow(/不是三段/);
  });
});
