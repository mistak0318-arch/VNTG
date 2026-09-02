import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCloses } from "./dailyCloses.js";
import { getConfig, type SignalConfig } from "./signalLight.js";

/**
 * **보관함** (2026-09-02 저녁) — 선 긋기로 보관한 옛 원장을 **계속 쫓아간다.**
 *
 * 벤티지: "원장 선긋기 하고 백업시키잖아. 그거 설정의 특정 메뉴에 하나 차려가지고
 * 거기에서 트래킹하는 메뉴 하나 만들 수 있어? 그때의 신호등 옵션값 달고 있어서
 * 체크해볼 수 있게. 좋은 신호값을 버리는 건 아닐까 싶어서" / "실제 메인에는 현재
 * 신호등 기준으로 가지만 예전에 버린 친구들도 동일하게 쫓아는 간다 이거지."
 *
 * ## 어떻게 쫓아가나 — 조회 0회
 *
 * 보관 파일(`*.archive-<날짜시각>.json`)은 그대로 두고, **읽을 때** 일봉 캐시로
 * 편입일 뒤 1·5·20거래일 수익률을 낸다. 일봉은 매일 자라니 성적도 저절로 자란다.
 * 지금 원장(`superSignal.json` 등)도 **같은 자로** 재서 나란히 놓는다 — 각 원장이
 * 자기 방식으로 낸 성적표와 섞지 않는다(자가 다르면 견줄 수 없다).
 *
 * ## 그때의 옵션값
 *
 * 선 긋기가 이제 `signalConfig.archive-<같은 날짜시각>.json` 을 같이 남긴다
 * (`ledgerReset`). 그 전 보관분(2026-09-02 00:20)은 지문(`configHash`)만 있다 —
 * 없는 것을 지어내지 않는다.
 *
 * ⚠️ 편입가는 원장이 적은 값(그날 모집단 조회가 준 값)이고 성적은 **편입일 봉의
 * 다음 봉부터** 센다. 원장 자체 성적표(편입일 종가 기준·지수 대비)와 숫자가 조금
 * 다를 수 있다 — 여기선 보관분과 지금 것을 **같은 방법으로** 재는 것이 요점이다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, "..", "data");

const KINDS = [
  { kind: "superSignal", label: "슈퍼신호등" },
  { kind: "signalTrack", label: "신호등 추적기" },
  { kind: "listTrack", label: "신호등 분석" },
] as const;
type Kind = (typeof KINDS)[number]["kind"];

export interface ArchiveMeta {
  /** YYYYMMDD-HHMM */
  stamp: string;
  /** 사람이 읽는 시각 */
  label: string;
  files: { kind: Kind; label: string; file: string; count: number }[];
  /** 그때의 설정 파일 — 있으면 */
  configFile?: string;
  /** 보관분 안에 든 지문들과 건수 */
  fingerprints: Record<string, number>;
  total: number;
}

export interface ArchiveRow {
  kind: Kind;
  code: string;
  name: string;
  /** YYYY-MM-DD */
  date: string;
  price: number;
  score: number;
  tier?: number;
  list?: string;
  configHash?: string;
  alerts?: unknown;
  d1: number | null;
  d5: number | null;
  d20: number | null;
  /** 편입일 뒤 봉이 몇 개 있나 — 0 이면 아직 못 잰다 */
  barsAfter: number;
}

export interface Horizon {
  n: number;
  avg: number | null;
  med: number | null;
  win: number | null;
}
export interface GroupStat {
  label: string;
  n: number;
  d1: Horizon;
  d5: Horizon;
  d20: Horizon;
}

export interface ArchiveReport {
  meta: ArchiveMeta;
  /** 보관분 성적 — 원장별 · 문턱/목록별 */
  archived: { kind: Kind; label: string; total: GroupStat; groups: GroupStat[]; rows: ArchiveRow[] }[];
  /** 지금 원장을 같은 자로 잰 것 — 나란히 놓는다 */
  live: { kind: Kind; label: string; total: GroupStat; groups: GroupStat[] }[];
  /** 그때의 설정 요약 — 없으면 null */
  config: ConfigSummary | null;
  /** 지금 설정과 무엇이 다른가 (그때 → 지금) */
  diff: string[];
  /** 일봉 캐시가 언제 것인가 — 성적이 어디까지 자랐나 */
  closesBuiltAt: string;
}

export interface ConfigSummary {
  configVersion?: number;
  configLabel?: string;
  greenAt: number;
  yellowAt: number;
  axisWeights: SignalConfig["axisWeights"];
  minCoverage: number;
  regimeSwitch: boolean;
  checks: {
    key: string;
    label: string;
    axis: string;
    weight: number;
    threshold: number;
    strongAt: number;
    capAt?: number;
    regime?: string;
    veto?: boolean;
    vetoAt?: number;
    span?: number;
  }[];
}

const ARCH_RE = /^(superSignal|signalTrack|listTrack)\.archive-(\d{8}-\d{4})\.json$/;

function stampLabel(stamp: string): string {
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)} ${stamp.slice(9, 11)}:${stamp.slice(11, 13)}`;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(join(DATA, file), "utf-8")) as T;
  } catch {
    return null;
  }
}

/** 원장 파일 하나를 공통 행으로 눕힌다 — 셋의 필드 이름이 다르다 */
function normalize(kind: Kind, j: { entries?: Record<string, unknown>[] } | null): Omit<ArchiveRow, "d1" | "d5" | "d20" | "barsAfter">[] {
  const entries = Array.isArray(j?.entries) ? j!.entries! : [];
  return entries
    .map((e) => {
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      if (kind === "signalTrack") {
        return { kind, code: String(e.code ?? ""), name: String(e.name ?? e.code ?? ""), date: String(e.date ?? ""), price: num(e.basePrice), score: num(e.score), tier: typeof e.tier === "number" ? e.tier : undefined, configHash: typeof e.configHash === "string" ? e.configHash : undefined, alerts: e.alerts };
      }
      return { kind, code: String(e.code ?? ""), name: String(e.name ?? e.code ?? ""), date: String(e.addedDate ?? ""), price: num(e.addedPrice), score: num(e.score), list: typeof e.list === "string" ? e.list : undefined, configHash: typeof e.configHash === "string" ? e.configHash : undefined, alerts: e.alerts };
    })
    .filter((r) => r.code && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.price > 0);
}

/** 편입일 다음 봉부터 k 번째 봉 종가의 편입가 대비 (%) */
function grade(rows: ReturnType<typeof normalize>, bars: Record<string, { d: string; c: number }[]>): ArchiveRow[] {
  return rows.map((r) => {
    const bs = bars[r.code] ?? [];
    const ymd = r.date.replace(/-/g, "");
    /* 편입일 봉(같은 날, 없으면 그 뒤 첫 봉)의 자리 */
    let i = bs.findIndex((b) => b.d >= ymd);
    if (i < 0) i = bs.length;
    const after = Math.max(0, bs.length - 1 - i);
    const at = (k: number): number | null => {
      const b = bs[i + k];
      return b && b.c > 0 ? Math.round(((b.c - r.price) / r.price) * 1000) / 10 : null;
    };
    return { ...r, d1: at(1), d5: at(5), d20: at(20), barsAfter: after };
  });
}

function horizon(vals: (number | null)[]): Horizon {
  const v = vals.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return { n: 0, avg: null, med: null, win: null };
  const m = v.length >> 1;
  return {
    n: v.length,
    avg: Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10,
    med: Math.round((v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2) * 10) / 10,
    win: Math.round((100 * v.filter((x) => x > 0).length) / v.length),
  };
}

function stat(label: string, rows: ArchiveRow[]): GroupStat {
  return { label, n: rows.length, d1: horizon(rows.map((r) => r.d1)), d5: horizon(rows.map((r) => r.d5)), d20: horizon(rows.map((r) => r.d20)) };
}

function groupsOf(kind: Kind, rows: ArchiveRow[]): GroupStat[] {
  if (kind === "signalTrack") {
    const tiers = [...new Set(rows.map((r) => r.tier ?? 0))].sort((a, b) => a - b);
    return tiers.map((t) => stat(`${t}점 문턱`, rows.filter((r) => (r.tier ?? 0) === t)));
  }
  if (kind === "listTrack") {
    const lists = [...new Set(rows.map((r) => r.list ?? "?"))].sort();
    return lists.map((l) => stat(l, rows.filter((r) => (r.list ?? "?") === l)));
  }
  /* 슈퍼신호등 — 점수대로 */
  const bands: [string, number, number][] = [["65~69", 65, 70], ["70~79", 70, 80], ["80~89", 80, 90], ["90~", 90, 101]];
  return bands.map(([l, lo, hi]) => stat(`${l}점`, rows.filter((r) => r.score >= lo && r.score < hi))).filter((g) => g.n > 0);
}

export async function listArchives(): Promise<ArchiveMeta[]> {
  const files = (await readdir(DATA).catch(() => [] as string[])).filter((f) => ARCH_RE.test(f) || /^signalConfig\.archive-\d{8}-\d{4}\.json$/.test(f));
  const by = new Map<string, ArchiveMeta>();
  for (const f of files) {
    const m = f.match(/archive-(\d{8}-\d{4})\.json$/);
    if (!m) continue;
    const stamp = m[1];
    const meta = by.get(stamp) ?? { stamp, label: stampLabel(stamp), files: [], fingerprints: {}, total: 0 };
    if (f.startsWith("signalConfig.")) {
      meta.configFile = f;
    } else {
      const kind = f.split(".")[0] as Kind;
      const j = await readJson<{ entries?: Record<string, unknown>[] }>(f);
      const rows = normalize(kind, j);
      meta.files.push({ kind, label: KINDS.find((k) => k.kind === kind)?.label ?? kind, file: f, count: rows.length });
      meta.total += rows.length;
      for (const r of rows) {
        const h = r.configHash ?? "(지문 없음)";
        meta.fingerprints[h] = (meta.fingerprints[h] ?? 0) + 1;
      }
    }
    by.set(stamp, meta);
  }
  return [...by.values()].sort((a, b) => b.stamp.localeCompare(a.stamp));
}

function summarize(c: SignalConfig): ConfigSummary {
  return {
    configVersion: c.configVersion,
    configLabel: c.configLabel,
    greenAt: c.greenAt,
    yellowAt: c.yellowAt,
    axisWeights: c.axisWeights,
    minCoverage: c.minCoverage,
    regimeSwitch: c.regimeSwitch,
    checks: c.checks
      .filter((x) => x.enabled)
      .map((x) => ({ key: x.key, label: x.label, axis: x.axis, weight: x.weight, threshold: x.threshold, strongAt: x.strongAt, capAt: x.capAt, regime: x.regime, veto: x.veto, vetoAt: x.vetoAt, span: x.span })),
  };
}

/** 그때 → 지금, 사람이 읽는 줄로 */
function diffConfig(then: ConfigSummary, now: ConfigSummary): string[] {
  const out: string[] = [];
  if (then.configVersion !== now.configVersion) {
    out.push(
      `세대 ${then.configVersion ?? "-"}${then.configLabel ? ` (${then.configLabel})` : ""} → ` +
        `${now.configVersion ?? "-"}${now.configLabel ? ` (${now.configLabel})` : ""}`,
    );
  }
  if (then.greenAt !== now.greenAt) out.push(`초록 문턱 ${then.greenAt} → ${now.greenAt}`);
  if (then.yellowAt !== now.yellowAt) out.push(`노랑 문턱 ${then.yellowAt} → ${now.yellowAt}`);
  for (const k of ["trend", "flow", "value"] as const) {
    if (then.axisWeights[k] !== now.axisWeights[k]) out.push(`${{ trend: "추세", flow: "수급", value: "실적" }[k]} 축 무게 ${then.axisWeights[k]} → ${now.axisWeights[k]}`);
  }
  if (then.minCoverage !== now.minCoverage) out.push(`최소 커버리지 ${then.minCoverage} → ${now.minCoverage}`);
  const thenBy = new Map(then.checks.map((c) => [c.key, c]));
  const nowBy = new Map(now.checks.map((c) => [c.key, c]));
  for (const [k, c] of thenBy) if (!nowBy.has(k)) out.push(`${c.label} 켬 → 끔`);
  for (const [k, c] of nowBy) if (!thenBy.has(k)) out.push(`${c.label} 끔 → 켬`);
  for (const [k, c] of thenBy) {
    const n = nowBy.get(k);
    if (!n) continue;
    const parts: string[] = [];
    if (c.weight !== n.weight) parts.push(`무게 ${c.weight}→${n.weight}`);
    if (c.threshold !== n.threshold || c.strongAt !== n.strongAt) parts.push(`문턱 ${c.threshold}/${c.strongAt}→${n.threshold}/${n.strongAt}`);
    if ((c.capAt ?? null) !== (n.capAt ?? null)) parts.push(`상한 ${c.capAt ?? "-"}→${n.capAt ?? "-"}`);
    if ((c.regime ?? "") !== (n.regime ?? "")) parts.push(`장세 ${c.regime ?? "무관"}→${n.regime ?? "무관"}`);
    if (Boolean(c.veto) !== Boolean(n.veto) || (c.vetoAt ?? null) !== (n.vetoAt ?? null)) parts.push(`탈락 ${c.veto ? c.vetoAt : "없음"}→${n.veto ? n.vetoAt : "없음"}`);
    if (parts.length) out.push(`${c.label}: ${parts.join(" · ")}`);
  }
  return out;
}

export async function archiveReport(stamp: string): Promise<ArchiveReport | null> {
  if (!/^\d{8}-\d{4}$/.test(stamp)) return null;
  const metas = await listArchives();
  const meta = metas.find((m) => m.stamp === stamp);
  if (!meta) return null;
  const { bars, builtAt } = await loadCloses();
  const barsOf = bars ?? {};

  const archived: ArchiveReport["archived"] = [];
  for (const f of meta.files) {
    const j = await readJson<{ entries?: Record<string, unknown>[] }>(f.file);
    const rows = grade(normalize(f.kind, j), barsOf).sort((a, b) => b.date.localeCompare(a.date) || b.score - a.score);
    archived.push({ kind: f.kind, label: f.label, total: stat("전체", rows), groups: groupsOf(f.kind, rows), rows });
  }
  const live: ArchiveReport["live"] = [];
  for (const k of KINDS) {
    const j = await readJson<{ entries?: Record<string, unknown>[] }>(`${k.kind}.json`);
    const rows = grade(normalize(k.kind, j), barsOf);
    live.push({ kind: k.kind, label: k.label, total: stat("전체", rows), groups: groupsOf(k.kind, rows) });
  }
  const thenCfg = meta.configFile ? await readJson<SignalConfig>(meta.configFile) : null;
  const config = thenCfg && Array.isArray(thenCfg.checks) ? summarize(thenCfg) : null;
  const nowCfg = summarize(await getConfig());
  return { meta, archived, live, config, diff: config ? diffConfig(config, nowCfg) : [], closesBuiltAt: builtAt };
}
