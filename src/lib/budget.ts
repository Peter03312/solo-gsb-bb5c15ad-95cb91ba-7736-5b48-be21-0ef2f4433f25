import type { Project } from '../types';
import { partUnder, totalSeconds } from './coverage';

/**
 * 排练前「分钟预算」分配：先满足每声部最少量，余量按各声部当前未达标总秒数
 * 比例分配；达到上限的声部退出，剩余声部重新分配（迭代封顶 / 注水）。
 * 未封顶（仍在池内）声部的缺口秒数全为 0 时对它们等权分配；
 * 取整后的整分钟尾差按小数余量降序、再按声部当前顺序补足，恰好用完预算。
 */

const EPS = 1e-9;

export interface BudgetEntry {
  key: string;
  /** 分配权重：该声部未达标总秒数（≥0 的有限数） */
  weight: number;
  /** 最少分钟数（非负整数） */
  min: number;
  /** 最多分钟数（非负整数；Infinity 表示不封顶） */
  max: number;
}

export interface BudgetAllocation {
  key: string;
  /** 作为分配依据的未达标秒数 */
  weight: number;
  min: number;
  max: number;
  /** 最终分得的整数分钟数 */
  minutes: number;
  /** 是否因达到上限而退出分配 */
  capped: boolean;
  /** 最终一轮的小数余量（封顶声部为 0；用于尾差排序与展示） */
  fraction: number;
}

export type BudgetErrorReason = 'empty' | 'invalid-total' | 'invalid-bound' | 'min-gt-max' | 'out-of-range';

export type BudgetResult =
  | { ok: true; total: number; allocations: BudgetAllocation[] }
  | { ok: false; reason: BudgetErrorReason; message: string };

function isNonNegInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n >= 0;
}

/**
 * 把整数分钟预算分配给各声部。纯函数，不修改入参。
 * 前置条件不满足时返回带原因的失败结果，不给出任何（旧）分配。
 */
export function allocateBudget(total: number, entries: BudgetEntry[]): BudgetResult {
  if (entries.length === 0) {
    return { ok: false, reason: 'empty', message: '工程中还没有声部，无法分配排练预算。' };
  }
  if (!isNonNegInt(total)) {
    return { ok: false, reason: 'invalid-total', message: '总分钟数必须是非负整数。' };
  }
  for (const e of entries) {
    if (
      !isNonNegInt(e.min) ||
      !(isNonNegInt(e.max) || e.max === Infinity) ||
      typeof e.weight !== 'number' ||
      !Number.isFinite(e.weight) ||
      e.weight < 0
    ) {
      return {
        ok: false,
        reason: 'invalid-bound',
        message: '每声部最少、最多分钟数必须是非负整数（最多可留空表示不封顶）。',
      };
    }
  }
  for (const e of entries) {
    if (e.min > e.max) {
      return { ok: false, reason: 'min-gt-max', message: `最少量不能大于最多量（声部「${e.key}」）。` };
    }
  }

  const sumMin = entries.reduce((acc, e) => acc + e.min, 0);
  // 任一不封顶则总和无上限
  const sumMax = entries.some((e) => e.max === Infinity)
    ? Infinity
    : entries.reduce((acc, e) => acc + (e.max as number), 0);
  if (total < sumMin || total > sumMax) {
    const range = sumMax === Infinity ? `至少 ${sumMin} 分钟` : `须在 ${sumMin}–${sumMax} 分钟之间`;
    return {
      ok: false,
      reason: 'out-of-range',
      message: `总预算 ${total} 分钟无法分配：各声部最少量合计 ${sumMin}、最多量合计 ${
        sumMax === Infinity ? '∞' : sumMax
      }，预算${range}。`,
    };
  }

  const n = entries.length;
  const minutes = entries.map((e) => e.min);
  const capped = new Array<boolean>(n).fill(false);
  let remaining = total - sumMin;

  // 迭代封顶：按比例（或等权）计算池内理想值，达到上限的声部按上限固定并退出，
  // 余量留给其余声部重新分配，直到没有声部新触顶。
  for (;;) {
    // 剩余容量为 0（如 min === max）的声部立即退出
    for (let i = 0; i < n; i++) {
      if (!capped[i] && entries[i].max - minutes[i] <= EPS) {
        minutes[i] = entries[i].max;
        capped[i] = true;
      }
    }
    const pool = indices(capped, false);
    if (pool.length === 0 || remaining <= EPS) break;

    const weightSum = pool.reduce((acc, i) => acc + entries[i].weight, 0);
    const hit: number[] = [];
    for (const i of pool) {
      const ideal = weightSum < EPS ? remaining / pool.length : (remaining * entries[i].weight) / weightSum;
      if (ideal >= entries[i].max - minutes[i] - EPS) hit.push(i);
    }
    if (hit.length === 0) break;
    for (const i of hit) {
      remaining -= entries[i].max - minutes[i];
      minutes[i] = entries[i].max;
      capped[i] = true;
    }
  }

  // 最终一轮：下取整 + 最大余数法补足不足整分钟的尾差
  const fractions = new Array<number>(n).fill(0);
  const pool = indices(capped, false);
  if (remaining > EPS && pool.length > 0) {
    const weightSum = pool.reduce((acc, i) => acc + entries[i].weight, 0);
    const idealOf = (i: number) =>
      weightSum < EPS ? remaining / pool.length : (remaining * entries[i].weight) / weightSum;
    for (const i of pool) {
      const ideal = idealOf(i);
      fractions[i] = ideal - Math.floor(ideal);
      minutes[i] += Math.floor(ideal);
    }
    // 取整误差归零后，剩余的整数分钟按小数余量降序、同量按声部当前顺序（索引升序）
    let left = total - minutes.reduce((acc, m) => acc + m, 0);
    const order = pool
      .slice()
      .sort((a, b) =>
        Math.abs(fractions[b] - fractions[a]) <= EPS ? a - b : fractions[b] - fractions[a],
      );
    for (const i of order) {
      if (left <= 0) break;
      minutes[i] += 1;
      left -= 1;
    }
  }

  return {
    ok: true,
    total,
    allocations: entries.map((e, i) => ({
      key: e.key,
      weight: e.weight,
      min: e.min,
      max: e.max,
      minutes: minutes[i],
      capped: capped[i],
      fraction: fractions[i],
    })),
  };
}

function indices(capped: boolean[], value: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < capped.length; i++) if (capped[i] === value) out.push(i);
  return out;
}

/** 每声部分配所需的边界输入（按 project.parts 顺序对齐）。 */
export interface PartBudgetBound {
  partId: string;
  min: number;
  max: number; // Infinity = 不封顶
}

export interface PartBudgetAllocation extends BudgetAllocation {
  partId: string;
  name: string;
  color: string;
}

export type PartBudgetResult =
  | { ok: true; total: number; allocations: PartBudgetAllocation[] }
  | { ok: false; reason: BudgetErrorReason; message: string };

/** 各声部当前（以当前工程覆盖计算的）未达标总秒数，按声部顺序返回。 */
export function partDeficitSeconds(project: Project): { partId: string; seconds: number }[] {
  return project.parts.map((p) => ({ partId: p.id, seconds: totalSeconds(partUnder(project, p.id)) }));
}

/**
 * 以当前工程各声部的未达标总秒数为权重，把整数分钟预算分配到声部。
 * 方案只在调用处展示，不写入工程。
 */
export function planRehearsalBudget(project: Project, total: number, bounds: PartBudgetBound[]): PartBudgetResult {
  const boundById = new Map(bounds.map((b) => [b.partId, b]));
  const entries: BudgetEntry[] = project.parts.map((p) => {
    const b = boundById.get(p.id) ?? { partId: p.id, min: 0, max: Infinity };
    return { key: p.id, weight: totalSeconds(partUnder(project, p.id)), min: b.min, max: b.max };
  });
  const result = allocateBudget(total, entries);
  if (!result.ok) {
    // 核心函数以 key（即 partId）定位声部；此处换成声部名便于阅读
    if (result.reason === 'min-gt-max') {
      const part = project.parts.find((p) => p.id === result.message.match(/「(.+?)」/)?.[1]);
      if (part) return { ...result, message: `最少量不能大于最多量（声部「${part.name}」）。` };
    }
    return result;
  }
  return {
    ok: true,
    total: result.total,
    allocations: result.allocations.map((a) => {
      const part = project.parts.find((p) => p.id === a.key)!;
      return { ...a, partId: part.id, name: part.name, color: part.color };
    }),
  };
}
