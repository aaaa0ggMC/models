/**
 * src/pages/Usage.tsx —— 用量 / 对账看板页。
 *
 * 顶部汇总卡（Semi Statistic：请求数 / 输入 token / 输出 token / 现金 / 等价 API / 未定价），
 * 下面最近记录表格 + 余额探测。不用文字描述这些数字。
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Col, Row, Table, Tag, Toast } from '@douyinfe/semi-ui';
import { useAuth } from '../auth';
import { errorText } from '../api/client';
import { fmtInt, fmtRatio, fmtTs, fmtUsd } from '../format';
import type { UsageDashboardResponse } from '../api/types';

const RANGES = [
  { label: '最近 24 小时', hours: 24 },
  { label: '最近 7 天', hours: 24 * 7 },
  { label: '最近 30 天', hours: 24 * 30 },
];

export function Usage(): JSX.Element {
  const { call } = useAuth();
  const [data, setData] = useState<UsageDashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<{ from_ts: number; to_ts: number }>(() => {
    const to = Date.now();
    return { from_ts: to - 24 * 3600 * 1000, to_ts: to };
  });

  const load = useCallback(
    async (r: { from_ts: number; to_ts: number }) => {
      setLoading(true);
      setError(null);
      try {
        const qs = `?from_ts=${r.from_ts}&to_ts=${r.to_ts}`;
        const res = await call<UsageDashboardResponse>(`/usage${qs}`);
        setData(res);
      } catch (e) {
        setError(errorText(e));
      } finally {
        setLoading(false);
      }
    },
    [call],
  );

  useEffect(() => {
    void load(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyRange = (hours: number): void => {
    const to = Date.now();
    const r = { from_ts: to - hours * 3600 * 1000, to_ts: to };
    setRange(r);
    void load(r);
  };

  const probeBalance = async (): Promise<void> => {
    const toastId = Toast.info('正在探测余额…');
    try {
      await call('/balance/probe', { method: 'POST', body: {} });
      Toast.close(toastId);
      Toast.success('余额已刷新');
      await load(range);
    } catch (e) {
      Toast.close(toastId);
      Toast.error(errorText(e));
    }
  };

  const s = data?.summary;

  const statCards: Array<{ title: string; value: number | string; suffix?: string }> = s
    ? [
        { title: '请求数', value: fmtInt(s.request_count) },
        { title: '输入 tokens', value: fmtInt(s.input_tokens) },
        { title: '输出 tokens', value: fmtInt(s.output_tokens) },
        { title: '现金费用', value: fmtUsd(s.cash_total), suffix: 'USD' },
        { title: '等价 API 价值', value: fmtUsd(s.as_api_total), suffix: 'USD' },
        { title: '未定价请求', value: fmtInt(s.unpriced_count) },
      ]
    : [];

  const recentColumns = [
    {
      title: '时间',
      dataIndex: 'ts',
      render: (_: unknown, r: NonNullable<UsageDashboardResponse['recent']>[number]) => (
        <span style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtTs(r.ts)}</span>
      ),
    },
    { title: 'provider', dataIndex: 'provider' },
    {
      title: 'model',
      dataIndex: 'model',
      render: (_: unknown, r: NonNullable<UsageDashboardResponse['recent']>[number]) => (
        <span style={{ fontFamily: 'monospace', fontSize: 12 }}>
          {r.model_alias ? `${r.model_alias} → ${r.model}` : r.model}
        </span>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: (_: unknown, r: NonNullable<UsageDashboardResponse['recent']>[number]) => (
        <Tag color={r.status === 'ok' || r.status === 'success' ? 'green' : 'orange'}>
          {r.status}
        </Tag>
      ),
    },
    {
      title: '输入',
      dataIndex: 'input_tokens',
      render: (_: unknown, r: NonNullable<UsageDashboardResponse['recent']>[number]) =>
        fmtInt(r.input_tokens),
    },
    {
      title: '输出',
      dataIndex: 'output_tokens',
      render: (_: unknown, r: NonNullable<UsageDashboardResponse['recent']>[number]) =>
        fmtInt(r.output_tokens),
    },
    {
      title: '费用',
      dataIndex: 'cash_total',
      render: (_: unknown, r: NonNullable<UsageDashboardResponse['recent']>[number]) =>
        fmtUsd(r.cash_total),
    },
    {
      title: 'finish',
      dataIndex: 'finish_reason',
      render: (_: unknown, r: NonNullable<UsageDashboardResponse['recent']>[number]) => (
        <span style={{ fontSize: 12 }}>{r.finish_reason}</span>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16, gap: 8 }}>
        {RANGES.map((r) => (
          <Button key={r.hours} onClick={() => applyRange(r.hours)}>
            {r.label}
          </Button>
        ))}
        <div style={{ flex: 1 }} />
        <Button theme="solid" type="primary" onClick={() => void probeBalance()}>
          探测余额
        </Button>
      </div>

      {error ? (
        <div style={{ color: 'var(--semi-color-danger)', marginBottom: 12 }}>{error}</div>
      ) : null}

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        {statCards.map((c) => (
          <Col key={c.title} span={4}>
            <Card bodyStyle={{ padding: 16 }}>
              <div style={{ fontSize: 12, opacity: 0.7 }}>{c.title}</div>
              <div style={{ fontSize: 22, fontWeight: 600, marginTop: 4 }}>
                {c.value}
                {c.suffix ? (
                  <span style={{ fontSize: 12, opacity: 0.6, marginLeft: 4 }}>{c.suffix}</span>
                ) : null}
              </div>
            </Card>
          </Col>
        ))}
      </Row>

      {s ? (
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 12 }}>
          区间 {fmtTs(s.from_ts)} → {fmtTs(s.to_ts)}
        </div>
      ) : null}

      <Card title="最近记录">
        <Table
          columns={recentColumns}
          dataSource={data?.recent ?? []}
          rowKey="request_id"
          loading={loading}
          pagination={false}
          empty="区间内没有请求记录。"
        />
      </Card>

      {data?.reconciliation ? (
        <Card title="对账" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 14 }}>
            <span>
              估算现金 <b>{fmtUsd(data.reconciliation.estimated_cash)}</b>
            </span>
            <span>
              实际充值增量 <b>{fmtUsd(data.reconciliation.actual_topped_up_delta)}</b>
            </span>
            <span>
              实际赠送增量 <b>{fmtUsd(data.reconciliation.actual_granted_delta)}</b>
            </span>
            <span>
              偏差 <b>{fmtRatio(data.reconciliation.deviation_ratio)}</b>（阈值{' '}
              {fmtRatio(data.reconciliation.alert_threshold)}）
            </span>
            {data.reconciliation.alert ? (
              <Tag color="red">偏差超阈值</Tag>
            ) : (
              <Tag color="green">偏差正常</Tag>
            )}
          </div>
        </Card>
      ) : null}

      {data?.balance && data.balance.length > 0 ? (
        <Card title="余额快照" style={{ marginTop: 16 }}>
          <Table
            columns={[
              { title: '币种', dataIndex: 'currency' },
              { title: '总额', dataIndex: 'total_balance' },
              { title: '赠送', dataIndex: 'granted_balance' },
              { title: '充值', dataIndex: 'topped_up_balance' },
            ]}
            dataSource={data.balance}
            rowKey="currency"
            pagination={false}
          />
        </Card>
      ) : null}
    </div>
  );
}
