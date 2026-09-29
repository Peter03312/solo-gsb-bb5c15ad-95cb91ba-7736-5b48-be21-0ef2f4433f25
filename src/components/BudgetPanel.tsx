import { useMemo, useState } from 'react';
import type { Project } from '../types';
import { allocateRehearsalBudget, projectPartDeficits } from '../lib/budget';

interface Props {
  project: Project;
}

function parseIntStrict(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null; // 拒绝空串、小数、负号、非数字
  return Number(t);
}

/**
 * 排练前分钟预算分配面板：输入总分钟数与每声部最少 / 最多分钟数，
 * 按当前工程各声部未达标总秒数分配整数分钟。纯页面计算，不写入工程、不持久化；
 * 工程改动后结果以当前覆盖重新计算；输入不通过校验时只显示原因、不显示旧结果。
 */
export default function BudgetPanel({ project }: Props) {
  const [totalRaw, setTotalRaw] = useState('30');
  // 每声部的最少 / 最多分钟输入（声部增删后越界索引按默认值处理）
  const [minRaw, setMinRaw] = useState<Record<string, string>>({});
  const [maxRaw, setMaxRaw] = useState<Record<string, string>>({});

  const deficits = useMemo(() => projectPartDeficits(project), [project]);

  const result = useMemo(() => {
    if (deficits.length === 0) return null;
    const total = parseIntStrict(totalRaw);
    const mins = deficits.map((d) => parseIntStrict(minRaw[d.partId] ?? '0'));
    const maxs = deficits.map((d) => parseIntStrict(maxRaw[d.partId] ?? '10'));
    if (total === null) return { ok: false as const, reason: '总分钟数必须是非负整数。' };
    if (mins.some((v) => v === null)) return { ok: false as const, reason: '每声部的最少分钟数必须是非负整数。' };
    if (maxs.some((v) => v === null)) return { ok: false as const, reason: '每声部的最多分钟数必须是非负整数。' };
    return allocateRehearsalBudget(project, {
      totalMinutes: total,
      minMinutes: mins as number[],
      maxMinutes: maxs as number[],
    });
  }, [project, deficits, totalRaw, minRaw, maxRaw]);

  const sumDeficit = deficits.reduce((a, d) => a + d.deficitSeconds, 0);

  return (
    <section className="optimizer budget-panel">
      <h3>⏱ 排练分钟预算分配（不写入工程）</h3>
      <p className="hint">
        输入本次排练的<b>总分钟数</b>与每声部的最少 / 最多分钟数：先满足各声部最少量，余量按当前工程
        <b>未达标秒数</b>比例分配，触及上限的声部退出后对其余声部重新分配；未封顶声部缺口全为零时等权分配，
        尾差按小数余量降序（再按声部当前顺序）补足，结果恰好用完预算。工程改动后以当前覆盖重新计算。
      </p>

      <div className="relay-form budget-total">
        <label className="relay-field">
          <span>总分钟数</span>
          <input type="number" min={0} step={1} value={totalRaw} onChange={(e) => setTotalRaw(e.target.value)} />
          <em className="relay-sep">分钟（非负整数）</em>
        </label>
        <span className="muted">当前全曲未达标合计 {sumDeficit.toFixed(1)}s</span>
      </div>

      {deficits.length === 0 ? (
        <p className="hint">工程中还没有声部，请先在左侧添加。</p>
      ) : (
        <table className="budget-table">
          <thead>
            <tr>
              <th>声部</th>
              <th>未达标秒数</th>
              <th>最少</th>
              <th>最多</th>
              <th>分得分钟</th>
            </tr>
          </thead>
          <tbody>
            {deficits.map((d) => (
              <tr key={d.partId}>
                <td>
                  <span className="dot" style={{ background: d.color }} />
                  <b>{d.name}</b>
                </td>
                <td className="muted">{d.deficitSeconds.toFixed(1)}s</td>
                <td>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={minRaw[d.partId] ?? '0'}
                    onChange={(e) =>
                      setMinRaw((m) => ({ ...m, [d.partId]: e.target.value }))
                    }
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={maxRaw[d.partId] ?? '10'}
                    onChange={(e) =>
                      setMaxRaw((m) => ({ ...m, [d.partId]: e.target.value }))
                    }
                  />
                </td>
                <td>
                  {result?.ok ? (
                    <span className="budget-out">
                      {result.parts.find((p) => p.partId === d.partId)?.minutes} 分钟
                      {result.parts.find((p) => p.partId === d.partId)?.capped && (
                        <em className="budget-capped">已封顶</em>
                      )}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {result && !result.ok && <p className="relay-error bad">⚠ {result.reason}</p>}
      {result?.ok && (
        <div className="diff">
          <span>
            合计分配 <b>{result.parts.reduce((a, p) => a + p.minutes, 0)}</b> / {result.totalMinutes} 分钟
            <span className="muted">（预算已恰好用完）</span>
          </span>
          <span className="badge ok">仅本次排练参考 · 工程未改动</span>
        </div>
      )}
    </section>
  );
}
