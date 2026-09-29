import type { Project } from '../types';
import { partUnder, totalSeconds } from './coverage';

const EPS = 1e-9;

/** 某一声部的当前未达标总秒数（分配分钟预算的依据）。 */
export interface PartDeficit {
  partId: string;
  name: string;
  color: string;
  /** 未达标总秒数（按当前工程覆盖实时计算） */
  deficitSeconds: number;
}

/** 逐声部统计当前未达标总秒数，顺序与 project.parts 一致。 */
export function projectPartDeficits(project: Project): PartDeficit[] {
  return project.parts.map((p) => ({
    partId: p.id,
    name: p.name,
    color: p.color,
    deficitSeconds: totalSeconds(partUnder(project, p.id)),
  }));
}

export interface BudgetInput {
  /** 排练总分钟预算（非负整数） */
  totalMinutes: number;
  /** 每声部最少分钟数，顺序与 project.parts 一致（非负整数） */
  minMinutes: number[];
  /** 每声部最多分钟数，顺序与 project.parts 一致（非负整数） */
  maxMinutes: number[];
}

export interface PartBudget extends PartDeficit {
  /** 实际分得的整数分钟数 */
  minutes: number;
  /** 是否因触及上限退出分配 */
  capped: boolean;
}

export type BudgetResult =
  | { ok: true; totalMinutes: number; parts: PartBudget[] }
  | { ok: false; reason: string };

function isNonNegInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n >= 0;
}

/**
 * 排练前按各声部「未达标总秒数」把整数分钟预算分配到每个声部：
 *
 * 1. 先给每个声部补足最少量；
 * 2. 余量在**未封顶**声部间按缺口秒数比例分配，触及上限的声部退出，
 *    其余声部带着剩余预算重新按比例分配（注水迭代）；
 * 3. 当前未封顶声部缺口秒数全为 0 时，在它们之间等权分配；
 * 4. 每轮取整用最大余数法：先各取 floor，剩余整分钟按小数余量降序补 1，
 *    小数余量相同按声部当前顺序（project.parts 顺序）补足。
 *
 * 结果分钟数恒为整数且总和恰等于总预算；输入不合法时返回原因、不给方案。
 */
export function allocateRehearsalBudget(project: Project, input: BudgetInput): BudgetResult {
  const deficits = projectPartDeficits(project);
  const n = deficits.length;
  const { totalMinutes, minMinutes, maxMinutes } = input;

  if (minMinutes.length !== n || maxMinutes.length !== n) {
    return { ok: false, reason: '声部数量与界限数量不一致，请按当前工程各声部分别填写最少、最多分钟数。' };
  }
  if (!isNonNegInt(totalMinutes)) {
    return { ok: false, reason: '总分钟数必须是非负整数。' };
  }
  if (!minMinutes.every(isNonNegInt) || !maxMinutes.every(isNonNegInt)) {
    return { ok: false, reason: '每声部的最少、最多分钟数必须是非负整数。' };
  }
  const badI = deficits.findIndex((_, i) => minMinutes[i] > maxMinutes[i]);
  if (badI >= 0) {
    return {
      ok: false,
      reason: `声部「${deficits[badI].name}」的最少量（${minMinutes[badI]} 分钟）大于最多量（${maxMinutes[badI]} 分钟）。`,
    };
  }
  const sumMin = minMinutes.reduce((a, b) => a + b, 0);
  const sumMax = maxMinutes.reduce((a, b) => a + b, 0);
  if (totalMinutes < sumMin) {
    return {
      ok: false,
      reason: `预算 ${totalMinutes} 分钟低于各声部最少量合计 ${sumMin} 分钟，无法先满足最少量。`,
    };
  }
  if (totalMinutes > sumMax) {
    return {
      ok: false,
      reason: `预算 ${totalMinutes} 分钟高于各声部最多量合计 ${sumMax} 分钟，余量无处分配。`,
    };
  }

  const alloc = minMinutes.slice();
  const capped = new Array<boolean>(n).fill(false);
  let remaining = totalMinutes - sumMin;

  // 注水迭代：每轮在未封顶声部间按权重分剩余预算，份额超上限者封顶退出后重分。
  while (remaining > 0) {
    const active = alloc.map((_, i) => i).filter((i) => alloc[i] < maxMinutes[i]);
    if (active.length === 0) break; // 理论上不可达：totalMinutes ≤ sumMax 已保证有容纳空间

    const weights = active.map((i) => Math.max(0, deficits[i].deficitSeconds));
    const weightSum = weights.reduce((a, b) => a + b, 0);
    // 未封顶声部缺口全为零 → 等权
    const w = weightSum <= EPS ? active.map(() => 1) : weights;
    const wSum = w.reduce((a, b) => a + b, 0);

    const hit: number[] = [];
    for (let k = 0; k < active.length; k++) {
      const i = active[k];
      const room = maxMinutes[i] - alloc[i];
      const share = (remaining * w[k]) / wSum;
      // 份额达到或超过剩余容量（零权重声部份额恒为 0，仅在容量本身为 0 时满足，
      // 而容量为 0 的声部不在 active 中）：该声部封顶退出，余量留给其余声部重分。
      if (share >= room - EPS && room > 0) {
        hit.push(i);
      }
    }
    if (hit.length > 0) {
      for (const i of hit) {
        const room = maxMinutes[i] - alloc[i];
        alloc[i] = maxMinutes[i];
        capped[i] = true;
        remaining -= room;
      }
      continue;
    }

    // 所有份额都不超上限：最大余数法取整——先各取 floor，再按小数余量降序补尾差
    const shares = active.map((_, k) => (remaining * w[k]) / wSum);
    const floors = shares.map((x) => Math.floor(x + EPS));
    active.forEach((i, k) => {
      alloc[i] += floors[k];
    });
    const leftover = remaining - floors.reduce((a, b) => a + b, 0);
    const order = shares
      .map((x, k) => ({ i: active[k], k, frac: x - floors[k] }))
      .slice()
      // 小数余量降序；差在 EPS 内视为相等，平局按声部当前顺序（active 中的原始下标）
      .sort((a, b) => {
        const d = b.frac - a.frac;
        if (d > EPS) return 1;
        if (d < -EPS) return -1;
        return a.k - b.k;
      });
    for (let k = 0; k < leftover; k++) {
      alloc[order[k].i] += 1;
    }
    remaining = 0;
  }

  return {
    ok: true,
    totalMinutes,
    parts: deficits.map((d, i) => ({ ...d, minutes: alloc[i], capped: capped[i] })),
  };
}
