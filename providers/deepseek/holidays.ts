/**
 * providers/deepseek/holidays.ts —— 中国法定节假日日历表（按年维护的数据加载器）。
 *
 * 为什么峰谷计费需要它：DeepSeek 官方价格页规定「Peak hours are 01:00 - 04:00 and
 * 06:00 - 10:00 UTC, Monday through Friday, **excluding Chinese public holidays**.
 * All other hours are off-peak, including weekends and Chinese public holidays in
 * full.」——节假日全天低谷，且周末规则自 2026-08-23 起生效（详见 pricing.json）。
 *
 * 三条硬规则（仓库主人定）：
 *   1. 表**按年维护**，唯一权威来源是国务院办公厅每年 11 月发布的
 *      《关于20XX年部分节假日安排的通知》——**不要用算法推算**节假日（农历 +
 *      调休规则没有稳定算法，推算必错）；
 *   2. 表里**缺失的日期按工作日保守处理**（可能多计），resolvePrice 会打
 *      `holiday_unknown` 标记，让对账时能看出"这天我们不知道是不是节假日"；
 *   3. 留出将来自公共节假日 API 生成的入口（见文件末的 HolidayRefreshHint）。
 *
 * 调休上班日（周末变成的工作日）单独列：中国日历存在这种日期，它们按**高峰**
 * 匹配（保守=可能多计），不能因为"是周六"就自动算低谷。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { HolidayCalendar } from '../../metering/pricing.js';

/** holidays.json 的路径（相对本文件，不依赖 process.cwd()）。 */
const HOLIDAYS_JSON_PATH = fileURLToPath(new URL('./holidays.json', import.meta.url));

interface HolidaysFile {
  year: number;
  source: string;
  holidays: string[];
  workdays: string[];
}

/** 读节假日表；结构损坏时抛错（启动失败好过带着错表计费）。 */
export function loadDeepSeekHolidayCalendars(): HolidayCalendar[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(HOLIDAYS_JSON_PATH, 'utf8')) as unknown;
  } catch (err) {
    throw new Error(`deepseek holidays.json 读取/解析失败: ${String(err)}`, { cause: err });
  }
  const file = raw as Partial<HolidaysFile>;
  if (
    typeof file.year !== 'number' ||
    typeof file.source !== 'string' ||
    !Array.isArray(file.holidays) ||
    !Array.isArray(file.workdays)
  ) {
    throw new Error(
      'deepseek holidays.json 结构不完整（需要 year / source / holidays / workdays）',
    );
  }
  return [
    {
      year: file.year,
      source: file.source,
      holidays: file.holidays.filter((d): d is string => typeof d === 'string'),
      workdays: file.workdays.filter((d): d is string => typeof d === 'string'),
    },
  ];
}

/**
 * 将来自公共节假日 API 刷新的入口占位。
 *
 * 形态先立起来：刷新只**追加新年份**，不改已发布年份的条目（与价格表的
 * 「只新增版本、不改旧版本」同一立场——历史记录不可重算）。
 */
export interface HolidayRefreshHint {
  year: number;
  /** 数据来源（API 名或官方通知 URL）。 */
  source: string;
  /** 建议由仓库主人确认后才写入 holidays.json。 */
  apply(): 'pending_review';
}
