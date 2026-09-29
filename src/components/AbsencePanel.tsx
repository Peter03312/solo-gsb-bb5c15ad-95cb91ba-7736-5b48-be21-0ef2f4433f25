import { useMemo, useState } from 'react';
import type { Project } from '../types';
import {
  type AbsenceInterval,
  clampAbsence,
} from '../lib/absence';
import { totalSeconds, type UnderSegment } from '../lib/coverage';
import { fmtSec } from '../lib/format';

interface Props {
  project: Project;
  /** 当前的临时缺席区间（按歌手 ID 索引；不写入工程） */
  absences: Map<string, AbsenceInterval[]>;
  /** 预演激活中（至少存在一段缺席） */
  active: boolean;
  /** 各声部由缺席新增的未达标时段（基于原工程做差） */
  added: Map<string, UnderSegment[]>;
  onAdd: (singerId: string, start: number, end: number) => void;
  onRemove: (singerId: string, intervalId: string) => void;
  onClear: () => void;
}

interface Row {
  singerId: string;
  singerName: string;
  partId: string;
  partName: string;
  partColor: string;
  items: AbsenceInterval[];
}

export default function AbsencePanel(props: Props) {
  const { project, active } = props;
  const [singerId, setSingerId] = useState(project.singers[0]?.id ?? '');
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(2);
  const [error, setError] = useState<string | null>(null);

  const effectiveSingerId = project.singers.some((s) => s.id === singerId)
    ? singerId
    : project.singers[0]?.id ?? '';

  /** 缺席条目按声部、再按开始时间排列，便于对照时间轴核对。 */
  const rows: Row[] = useMemo(() => {
    const partById = new Map(project.parts.map((p) => [p.id, p]));
    return project.singers
      .map((s) => {
        const part = partById.get(s.partId);
        return {
          singerId: s.id,
          singerName: s.name,
          partId: s.partId,
          partName: part?.name ?? '声部',
          partColor: part?.color ?? '#60a5fa',
          items: (props.absences.get(s.id) ?? [])
            .slice()
            .sort((a, b) => a.start - b.start || a.end - b.end),
        };
      })
      .filter((r) => r.items.length > 0);
  }, [project.parts, project.singers, props.absences]);

  const addedTotal = useMemo(
    () => project.parts.reduce((acc, p) => acc + totalSeconds(props.added.get(p.id) ?? []), 0),
    [project.parts, props.added],
  );

  const add = () => {
    const seg = clampAbsence(start, end, project.duration);
    if (!seg) {
      setError(
        `区间无效：起、止须为 0–${project.duration} 秒内的有限数，且结束晚于开始（半开 [起, 止)）。`,
      );
      return;
    }
    setError(null);
    props.onAdd(effectiveSingerId, seg.start, seg.end);
  };

  return (
    <section className="optimizer absence-panel">
      <h3>🚪 临时缺席预演（只影响当前页面）</h3>
      <p className="hint">
        为多位歌手分别添加以秒计的临时缺席区间（半开 [起, 止)）。缺席会先与该歌手的既有换气
        <b>合并去重</b>（重叠也只扣一人），再按声部重算覆盖；时间轴上<b>仅标出由缺席新增的未达标时段</b>，
        原本就不足的时段仍以暗色显示。不写入工程、不改动换气段；切换 / 编辑工程自动清空，退出即恢复原覆盖。
      </p>

      <div className="relay-form">
        <label className="relay-field">
          <span>歌手</span>
          <select value={effectiveSingerId} onChange={(e) => setSingerId(e.target.value)}>
            {project.parts.flatMap((p) => {
              const singers = project.singers.filter((s) => s.partId === p.id);
              if (singers.length === 0) return [];
              return [
                <optgroup key={p.id} label={p.name}>
                  {singers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </optgroup>,
              ];
            })}
          </select>
        </label>
        <label className="relay-field">
          <span>起</span>
          <input
            type="number"
            min={0}
            step={0.5}
            value={start}
            onChange={(e) => setStart(Number(e.target.value))}
          />
          <em className="relay-sep">秒（含）</em>
        </label>
        <label className="relay-field">
          <span>止</span>
          <input
            type="number"
            min={0}
            step={0.5}
            value={end}
            onChange={(e) => setEnd(Number(e.target.value))}
          />
          <em className="relay-sep">秒（不含）</em>
        </label>
        <button className="primary" onClick={add} disabled={project.singers.length === 0}>
          添加缺席
        </button>
        <button onClick={props.onClear} disabled={!active}>
          全部移除并退出预演
        </button>
      </div>
      {error && <p className="relay-error bad">⚠ {error}</p>}

      {active ? (
        <div className="opt-result">
          <div className="diff">
            <span>
              由缺席新增的未达标合计{' '}
              <b className={addedTotal > 0 ? 'absence-bad' : 'ok'}>{addedTotal.toFixed(1)}s</b>
            </span>
            <span className="badge absence-badge">预演中 · 工程未改动</span>
          </div>
          <ul className="absence-part-stats">
            {project.parts.map((p) => {
              const sec = totalSeconds(props.added.get(p.id) ?? []);
              return (
                <li key={p.id}>
                  <span className="dot" style={{ background: p.color }} />
                  <b>{p.name}</b>
                  <span className={sec > 0 ? 'absence-bad muted' : 'ok muted'}>
                    {sec > 0 ? `新增未达标 ${sec.toFixed(1)}s` : '无新增'}
                  </span>
                </li>
              );
            })}
          </ul>

          {rows.length === 0 ? (
            <p className="hint">暂无缺席区间。</p>
          ) : (
            <ul className="absence-list">
              {rows.map((r) =>
                r.items.map((a) => (
                  <li key={a.id}>
                    <span className="dot" style={{ background: r.partColor }} />
                    <span className="absence-singer">{r.singerName}</span>
                    <span className="muted">
                      {r.partName} · {fmtSec(a.start)} – {fmtSec(a.end)}（{(a.end - a.start).toFixed(1)}s）
                    </span>
                    <button
                      className="icon-btn"
                      title="移除该缺席区间"
                      onClick={() => props.onRemove(r.singerId, a.id)}
                    >
                      ✕
                    </button>
                  </li>
                )),
              )}
            </ul>
          )}
        </div>
      ) : project.singers.length === 0 ? (
        <p className="hint">工程中没有歌手时请先在左侧添加。</p>
      ) : (
        <p className="hint">尚未添加缺席区间：选择歌手并填写起止秒数后点击「添加缺席」即进入预演。</p>
      )}
    </section>
  );
}
