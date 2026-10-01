import { useMemo, useState } from 'react';
import type { Project } from '../types';
import { partDeficitSeconds, planRehearsalBudget, type PartBudgetResult } from '../lib/budget';

interface Props {
  project: Project;
}

/**
 * 排练分钟预算：以当前工程各声部未达标总秒数为依据分配整数分钟。
 * 纯页面计算（useMemo 随当前覆盖重算），不写入工程、不持久化；
 * 输入不合法时展示原因，且不保留上一次分配结果。
 */
export default function BudgetPanel({ project }: Props) {
  const [open, setOpen] = useState(false);
  const [total, setTotal] = useState('60');
  /** 每声部边界按 partId 记录（min/max 为输入框原文，空 max = 不封顶）。 */
  const [bounds, setBounds] = useState<Record<string, { min: string; max: string }>>({});

  const deficits = useMemo(() => partDeficitSeconds(project), [project]);
  const deficitById = useMemo(() => new Map(deficits.map((d) => [d.partId, d.seconds])), [deficits]);

  /**
   * 始终按「当前输入 × 当前覆盖」重算：工程改动后下一次渲染即用新覆盖；
   * 不保存上一次方案，因此失败时只有原因、没有旧结果可展示。
   */
  const result: PartBudgetResult | null = useMemo(() => {
    if (!open || project.parts.length === 0) return null;
    const t = Number(total);
    if (!/^\d+$/.test(total.trim()) || !Number.isSafeInteger(t)) {
      return { ok: false, reason: 'invalid-total', message: '总分钟数必须是非负整数。' };
    }
    const parsed = project.parts.map((p) => {
      const b = bounds[p.id] ?? { min: '', max: '' };
      return { partId: p.id, minText: b.min.trim(), maxText: b.max.trim() };
    });
    if (parsed.some((b) => !/^\d+$/.test(b.minText) || (b.maxText !== '' && !/^\d+$/.test(b.maxText)))) {
      return {
        ok: false,
        reason: 'invalid-bound',
        message: '每声部最少、最多分钟数必须是非负整数；最多留空表示不封顶。',
      };
    }
    const nums = parsed.map((b) => ({
      partId: b.partId,
      min: Number(b.minText),
      max: b.maxText === '' ? Infinity : Number(b.maxText),
    }));
    if (nums.some((b) => !Number.isSafeInteger(b.min) || (b.max !== Infinity && !Number.isSafeInteger(b.max)))) {
      return { ok: false, reason: 'invalid-bound', message: '分钟数超出安全整数范围，请改小。' };
    }
    return planRehearsalBudget(project, t, nums);
  }, [open, total, bounds, project]);

  const setBound = (partId: string, field: 'min' | 'max', text: string) => {
    setBounds((m) => {
      const cur = m[partId];
      return { ...m, [partId]: { min: cur?.min ?? '0', max: cur?.max ?? '', [field]: text } };
    });
  };

  return (
    <section className="optimizer budget-panel">
      <h3 onClick={() => setOpen((v) => !v)} className="budget-toggle" title="展开 / 收起">
        ⏱ 排练前分钟预算分配 {open ? '▾' : '▸'}
      </h3>
      {open && (
        <>
          <p className="hint">
            输入本次排练的<b>总分钟数</b>与每声部<b>最少 / 最多分钟数</b>（最多留空表示不封顶）：先满足各声部最少量，
            余量按当前各声部<b>未达标总秒数</b>比例分配；达到上限的声部退出，其余声部重新分配；未封顶声部缺口全为 0
            时等权分配，尾差按小数余量降序、再按声部顺序补足，恰好用完预算。方案只用于本页查看，<b>不写入工程</b>；
            工程改动后按当前覆盖重新计算。
          </p>

          <div className="relay-form">
            <label className="relay-field">
              <span>总分钟数</span>
              <input
                type="number"
                min={0}
                step={1}
                value={total}
                onChange={(e) => setTotal(e.target.value)}
              />
            </label>
            <span className="muted">
              最少合计 {project.parts.reduce((acc, p) => acc + parseOr(bounds[p.id]?.min, 0), 0)} 分钟
            </span>
          </div>

          <table className="cand-table budget-table">
            <thead>
              <tr>
                <th>声部</th>
                <th>未达标秒数（依据）</th>
                <th>最少分钟</th>
                <th>最多分钟</th>
                <th>分得分钟</th>
              </tr>
            </thead>
            <tbody>
              {project.parts.map((p) => {
                const b = bounds[p.id] ?? { min: '0', max: '' };
                const alloc = result?.ok ? result.allocations.find((a) => a.partId === p.id) : undefined;
                return (
                  <tr key={p.id}>
                    <td>
                      <span className="dot" style={{ background: p.color }} /> <b>{p.name}</b>
                    </td>
                    <td className={deficitById.get(p.id)! > 0 ? 'bad' : 'ok muted'}>
                      {(deficitById.get(p.id) ?? 0).toFixed(1)}s
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={b.min}
                        onChange={(e) => setBound(p.id, 'min', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        placeholder="∞"
                        value={b.max}
                        onChange={(e) => setBound(p.id, 'max', e.target.value)}
                      />
                    </td>
                    <td>{alloc ? <b>{alloc.minutes} 分钟</b> : <span className="muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {project.parts.length === 0 ? (
            <p className="relay-error bad">⚠ 工程中还没有声部，无法分配排练预算。</p>
          ) : result && !result.ok ? (
            <p className="relay-error bad">⚠ {result.message}（请调整输入，此前结果不保留）</p>
          ) : result?.ok ? (
            <div className="opt-result">
              <div className="diff">
                <span>
                  合计分配 <b>{result.allocations.reduce((acc, a) => acc + a.minutes, 0)}</b> / {result.total} 分钟
                  （恰好用完）
                </span>
                <span className="badge ok">分配完成</span>
                {result.allocations.some((a) => a.capped) && (
                  <span className="muted">
                    封顶声部：
                    {result.allocations
                      .filter((a) => a.capped)
                      .map((a) => a.name)
                      .join('、')}
                  </span>
                )}
              </div>
              <div className="stats">依据为各声部当前覆盖的未达标总秒数；改动工程或边界后结果自动重算。</div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function parseOr(text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback;
  const t = text.trim();
  return /^\d+$/.test(t) ? Number(t) : fallback;
}
