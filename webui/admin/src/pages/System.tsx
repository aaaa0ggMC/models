/**
 * src/pages/System.tsx —— 系统页：密钥状态 + 代价说明 + 密钥轮换 + 关于。
 *
 * 密钥代价说明（keystore.tradeoff_note）是 65-storage-and-retention.md §3.2b 要求
 * **原样展示**的硬约束：这里压成**一行**（CSS 截断，不改写文本）+ 「查看详情」弹窗
 * 给完整原文——既满足「不得改写」，又不让大段文字占据版面。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Banner,
  Button,
  Card,
  Input,
  Modal,
  Table,
  Tag,
  Toast,
  Typography,
} from '@douyinfe/semi-ui';
import { useAuth } from '../auth';
import { errorText } from '../api/client';
import { fmtBool, fmtInt } from '../format';
import type { KeystoreStatusResponse } from '../api/types';

const TRADEOFF_SOURCE =
  '来源：docs/design/65-storage-and-retention.md §3.2b「自动解锁换不来运行时防护」';

export function System(): JSX.Element {
  const { call, bootstrap } = useAuth();
  const [status, setStatus] = useState<KeystoreStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNote, setShowNote] = useState(false);
  const [kekOpen, setKekOpen] = useState(false);
  const [kekPass, setKekPass] = useState('');

  const note = status?.tradeoff_note ?? bootstrap?.keystore?.tradeoff_note ?? '';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await call<KeystoreStatusResponse>('/keystore/status');
      setStatus(res);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const rotateKek = async (): Promise<void> => {
    if (
      !window.confirm(
        '轮换 KEK 会让旧密钥表作废：没有备份的数据将永久解不开。\n' +
          (status?.mode === 'passphrase' ? '旧口令也会立即失效。' : 'key 文件内容会被替换。') +
          '\n确定继续？',
      )
    ) {
      return;
    }
    try {
      const body: { confirm: boolean; new_passphrase?: string } = { confirm: true };
      if (status?.mode === 'passphrase') {
        if (kekPass.length === 0) {
          Toast.error('请先填新口令');
          return;
        }
        body.new_passphrase = kekPass;
      }
      const res = await call<{ ok: boolean; kek_fingerprint?: string; error?: string }>(
        '/keystore/rotate-kek',
        { method: 'POST', body },
      );
      if (res.ok) Toast.success(`已完成。新 KEK 指纹：${res.kek_fingerprint ?? '（服务端未回）'}`);
      else Toast.error(res.error ?? '轮换失败');
      setKekPass('');
      setKekOpen(false);
      await load();
    } catch (e) {
      Toast.error(errorText(e));
    }
  };

  const rotateDek = async (): Promise<void> => {
    if (!window.confirm('轮换 DEK 会把历史记录用新 DEK 重加密，期间写入会短暂受影响。继续？'))
      return;
    try {
      const res = await call<{
        ok: boolean;
        new_dek_id?: string;
        reencrypted?: number;
        error?: string;
      }>('/keystore/rotate-dek', { method: 'POST', body: {} });
      if (res.ok)
        Toast.success(
          `已完成。新 DEK：${res.new_dek_id ?? '（未回）'}，重加密 ${fmtInt(res.reencrypted ?? 0)} 条。`,
        );
      else Toast.error(res.error ?? '轮换失败');
      await load();
    } catch (e) {
      Toast.error(errorText(e));
    }
  };

  const statusRows = status
    ? [
        {
          key: 'mode',
          label: '解锁模式',
          value: status.mode === 'passphrase' ? '启动口令（passphrase）' : '密钥文件（key_file）',
        },
        {
          key: 'unlocked',
          label: '已解锁',
          value: <Tag color={status.unlocked ? 'green' : 'red'}>{fmtBool(status.unlocked)}</Tag>,
        },
        {
          key: 'dek',
          label: '当前 DEK',
          value: <span style={{ fontFamily: 'monospace' }}>{status.active_dek_id || '—'}</span>,
        },
        { key: 'count', label: '已加密条数', value: fmtInt(status.encryption_count) },
        { key: 'rotate_dek', label: '建议轮换 DEK', value: status.should_rotate_dek ? '是' : '否' },
        {
          key: 'argon2',
          label: '建议重算 Argon2',
          value: status.argon2_rehash_recommended ? '是（重新派生口令即可，数据不丢）' : '否',
        },
        {
          key: 'kek',
          label: 'KEK 指纹',
          value: <span style={{ fontFamily: 'monospace' }}>{status.kek_fingerprint || '—'}</span>,
        },
      ]
    : [];

  return (
    <div style={{ maxWidth: 760 }}>
      {bootstrap?.storage_unlocked === false ? (
        <Banner
          type="warning"
          description="加密存储未解锁：界面能打开，但任何需要读 secret 的操作都会失败。请先按部署文档解锁密钥存储。"
          style={{ marginBottom: 16 }}
        />
      ) : null}

      {error ? (
        <div style={{ color: 'var(--semi-color-danger)', marginBottom: 12 }}>{error}</div>
      ) : null}

      <Card
        title="密钥状态"
        style={{ marginBottom: 16 }}
        headerExtraContent={
          <Button size="small" onClick={() => void load()}>
            刷新
          </Button>
        }
      >
        <Table
          columns={[
            { title: '项', dataIndex: 'label', width: 180 },
            { title: '值', dataIndex: 'value' },
          ]}
          dataSource={statusRows}
          rowKey="key"
          loading={loading}
          pagination={false}
          empty="读不到密钥状态。"
        />
      </Card>

      {note.length > 0 ? (
        <Card title="密钥自动解锁的代价" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Typography.Text
              type="warning"
              style={{
                flex: 1,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              title={note}
            >
              ⚠️ {note}
            </Typography.Text>
            <Button size="small" onClick={() => setShowNote(true)}>
              查看详情
            </Button>
          </div>
          <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6 }}>
            {TRADEOFF_SOURCE}（服务端原文，未作任何改写）
          </div>
        </Card>
      ) : null}

      <Card title="密钥轮换（破坏性操作）" style={{ marginBottom: 16 }}>
        <Typography.Text
          type="tertiary"
          style={{ display: 'block', marginBottom: 12, fontSize: 13 }}
        >
          KEK 轮换只重包裹 DEK，数据密文不动；DEK
          轮换会重加密历史记录。两者都会记入审计日志；网关没注入对应端口时会明确返回
          501，不假装成功。
        </Typography.Text>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button type="danger" theme="light" onClick={() => setKekOpen(true)}>
            轮换 KEK
          </Button>
          <Button type="danger" theme="light" onClick={() => void rotateDek()}>
            轮换 DEK
          </Button>
        </div>
      </Card>

      <Card title="关于">
        <Typography.Text type="tertiary" style={{ fontSize: 13 }}>
          AgentGateway 管理面 · Vite + React 18 + Semi Design · 控制面 API{' '}
          {bootstrap?.api_version ?? '版本未知'}。 会话令牌只在页面内存中，刷新即失效。
        </Typography.Text>
      </Card>

      <Modal
        visible={showNote}
        onCancel={() => setShowNote(false)}
        onOk={() => setShowNote(false)}
        title="密钥自动解锁的代价（服务端原文，未作任何改写）"
      >
        <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{note}</p>
        <div style={{ fontSize: 12, opacity: 0.6, marginTop: 12 }}>{TRADEOFF_SOURCE}</div>
      </Modal>

      <Modal
        visible={kekOpen}
        onCancel={() => setKekOpen(false)}
        onOk={() => void rotateKek()}
        title="轮换 KEK（破坏性）"
        okText="确认轮换"
      >
        {status?.mode === 'passphrase' ? (
          <div>
            <Typography.Text strong>新口令</Typography.Text>
            <Input
              type="password"
              style={{ marginTop: 6 }}
              value={kekPass}
              onChange={setKekPass}
              placeholder="轮换后旧口令立即失效"
            />
          </div>
        ) : (
          <Typography.Text>key_file 模式下服务端忽略口令，直接读新的 key 文件。</Typography.Text>
        )}
      </Modal>
    </div>
  );
}
