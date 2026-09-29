import type { Project } from '../types';
import {
  mergeSegments,
  partUnder,
  type Segment,
  type UnderSegment,
} from './coverage';

const EPS = 1e-6;

/**
 * 临时缺席区间：半开区间 [start, end)，单位秒。
 * 只存在于页面状态：不写入工程、不改动换气段、不持久化，编辑 / 切换工程时整体清空。
 */
export interface AbsenceInterval extends Segment {
  id: string;
}

/**
 * 合并一位歌手的既有换气与临时缺席（半开区间并集）：重叠或首尾相接处并为一段。
 * 这样在声部覆盖扫描中，该歌手任一时刻至多贡献 1 个「不发声」计数，
 * 避免缺席与换气（或缺席与缺席）重叠时同一位歌手被重复扣人。
 */
export function mergeUnavailable(breaths: Segment[], absences: Segment[]): Segment[] {
  return mergeSegments([...breaths, ...absences]);
}

/**
 * 清洗单个缺席输入：非有限数拒绝，区间裁剪到 [0, duration]，零长度丢弃。
 * 返回 null 表示该区间无效。
 */
export function clampAbsence(start: number, end: number, duration: number): Segment | null {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const s = Math.min(Math.max(0, start), duration);
  const e = Math.min(Math.max(0, end), duration);
  if (e - s <= EPS) return null;
  return { start: s, end: e };
}

/**
 * 返回叠加临时缺席后的新工程（不可变）：每位歌手的「不发声区间」为其换气与缺席
 * 按半开区间合并后的并集；原工程与原换气段均不被修改。
 * 合并段是只用于覆盖计算的临时段（合成 id），不会出现在时间轴的换气块里。
 */
export function applyAbsences(project: Project, absences: Map<string, AbsenceInterval[]>): Project {
  const has = [...absences.values()].some((list) => list.length > 0);
  if (!has) return project;
  return {
    ...project,
    singers: project.singers.map((s) => {
      const extra = absences.get(s.id);
      if (!extra || extra.length === 0) return s;
      return {
        ...s,
        breaths: mergeUnavailable(s.breaths, extra).map((seg, i) => ({
          id: `${s.id}::absence-${i}`,
          start: seg.start,
          end: seg.end,
        })),
      };
    }),
  };
}

/**
 * 半开区间集合差 a \\ b：返回属于 a 但不在 b 覆盖范围内的时段（b 先按半开区间合并）。
 * 差分只切时间，切出的子段继承 a 段的最少人数 / 缺口统计。
 */
export function subtractUnder(a: UnderSegment[], b: Segment[]): UnderSegment[] {
  const cover = mergeSegments(b);
  const out: UnderSegment[] = [];
  for (const seg of a) {
    let cursor = seg.start;
    for (const c of cover) {
      if (c.end <= cursor + EPS) continue; // c 完全在游标之前
      if (c.start >= seg.end - EPS) break; // c 已越过本段（cover 已排序）
      const cutStart = Math.max(cursor, c.start);
      if (cutStart - cursor > EPS) {
        out.push({ start: cursor, end: cutStart, minSinging: seg.minSinging, deficit: seg.deficit });
      }
      cursor = Math.max(cursor, Math.min(seg.end, c.end));
    }
    if (seg.end - cursor > EPS) {
      out.push({ start: cursor, end: seg.end, minSinging: seg.minSinging, deficit: seg.deficit });
    }
  }
  return out;
}

/**
 * 对比原工程 baseProject，逐声部计算「由缺席新增的未达标时段」：
 * 预演后的未达标时段减去原工程已有的未达标时段（半开集合差）。
 * 原本就未达标的时间不计入新增。
 */
export function addedUnderSegments(
  baseProject: Project,
  previewProject: Project,
): Map<string, UnderSegment[]> {
  const m = new Map<string, UnderSegment[]>();
  for (const part of previewProject.parts) {
    const base = partUnder(baseProject, part.id);
    const preview = partUnder(previewProject, part.id);
    m.set(part.id, subtractUnder(preview, base));
  }
  return m;
}
