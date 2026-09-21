import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **「왜 안 샀나」를 사유별로 센다** (2026-09-21 — 벤티지: "얘는 매매도 안하고 돈도 못벌고 이상해서 …
 * 배울게없다랄까").
 *
 * 항해일지는 가상 인물이 이 HTS 를 써서 굴리는 **모의 계좌**다. 그 인물이 이 도구를 얼마나 써먹는지
 * 보려면 「무엇을 샀나」보다 **「무엇 때문에 안 샀나」** 가 더 많은 것을 말한다. 그런데 여태 그 기록이
 * 이런 모양이었다:
 *
 *   · 15분 스캔은 한 줄짜리 글로 남는다 — 탈락 사유는 **상위 3개 이름만**
 *   · 일지는 탈락을 앞 6~8개만 적고, **시장 문이 닫히면 목록 자체를 안 쓴다**
 *   · `planBuys` 의 「자리 없음·이미 보유·여력 부족」은 **아무 데도 안 남고 버려진다**
 *   · 사유별 집계는 어디에도 없다
 *
 * 그래서 「이번 달에 뭐 때문에 제일 많이 안 샀나」를 **물을 자리가 없었다.** 배울 게 없는 것이
 * 당연하다 — 기록이 그 질문에 답할 수 있는 모양이 아니다.
 *
 * ⚠️ **세기만 한다.** 매수 판단은 한 줄도 안 건드린다 — 무엇을 고칠지는 이 숫자가 쌓인 뒤에 정한다.
 *
 * 사유 글은 숫자가 섞여 제각각이라(「점수 52 < 55」) 그대로 세면 전부 따로 잡힌다. **숫자를 N 으로
 * 바꿔** 묶는다 — 「점수 N < N」 하나로 모인다. 종목 이름은 안 싣는다(사유만 센다).
 */

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "cis", "whyNot");

export interface WhyNotDay {
  day: string;
  acc: Record<
    string,
    {
      /** 15분 스캔이 몇 번 돌았나 */
      scans: number;
      /** 그중 시장 문이 닫혀 후보를 아예 안 본 회차 */
      marketShut: number;
      /** 후보가 문을 다 지난 횟수(종목 수 합) */
      passed: number;
      /** 계획까지 간 수 · 실제로 산 수 */
      planned: number;
      bought: number;
      /** 사유 → 몇 번 */
      reasons: Record<string, number>;
    }
  >;
}

const cache = new Map<string, WhyNotDay>();

function kstDay(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

/** 숫자를 N 으로 — 「점수 52 < 55」와 「점수 48 < 55」를 한 칸으로 모은다 */
function norm(reason: string): string {
  const s = (reason || "사유 없음").replace(/[\d][\d,._]*%?/g, "N").replace(/\s+/g, " ").trim();
  return s.length > 48 ? `${s.slice(0, 48)}…` : s;
}

async function load(day: string): Promise<WhyNotDay> {
  const hit = cache.get(day);
  if (hit) return hit;
  let v: WhyNotDay = { day, acc: {} };
  try {
    const raw = JSON.parse(await readFile(join(DIR, `${day}.json`), "utf-8")) as WhyNotDay;
    if (raw && raw.day === day && raw.acc) v = raw;
  } catch {
    /* 없으면 오늘이 처음이다 */
  }
  cache.set(day, v);
  return v;
}

function slotOf(v: WhyNotDay, id: string): WhyNotDay["acc"][string] {
  return (v.acc[id] ??= { scans: 0, marketShut: 0, passed: 0, planned: 0, bought: 0, reasons: {} });
}

/**
 * 한 회차(15분 스캔 또는 종배 저녁)의 결과를 센다.
 *
 * 실패해도 던지지 않는다 — 세는 일 때문에 매수 회차가 죽으면 본말전도다.
 */
export async function noteWhyNot(
  id: string,
  r: {
    gateOk: boolean;
    gateReason?: string;
    /** 체에 걸린 것 — 사유 글 */
    sieved?: string[];
    /** 자리 조건 미달 — 사유 글 */
    gateBad?: string[];
    /** 계좌가 못 담아서 / 이미 보유 / 여력 부족 등 조용히 버려지던 것 */
    skipped?: string[];
    passed?: number;
    planned?: number;
    bought?: number;
  },
): Promise<void> {
  try {
    const day = kstDay();
    const v = await load(day);
    const s = slotOf(v, id);
    s.scans += 1;
    const add = (why: string) => {
      const k = norm(why);
      s.reasons[k] = (s.reasons[k] ?? 0) + 1;
    };
    if (!r.gateOk) {
      s.marketShut += 1;
      add(`시장문 — ${r.gateReason ?? ""}`);
    } else {
      for (const x of r.sieved ?? []) add(`체 — ${x}`);
      for (const x of r.gateBad ?? []) add(`자리 — ${x}`);
      for (const x of r.skipped ?? []) add(`계좌 — ${x}`);
      s.passed += r.passed ?? 0;
      s.planned += r.planned ?? 0;
      s.bought += r.bought ?? 0;
      /* 다 지났는데 한 주도 못 산 회차 — 계좌 쪽에서 막힌 것이다 */
      if ((r.passed ?? 0) > 0 && (r.bought ?? 0) === 0 && (r.planned ?? 0) === 0) add("계좌 — 통과했는데 계획 0");
    }
    await mkdir(DIR, { recursive: true });
    await writeFile(join(DIR, `${day}.json`), JSON.stringify(v), "utf-8");
  } catch {
    /* 못 적어도 다음 회차에 */
  }
}

/** health.json 한 칸 — 오늘치 요약. 종목·금액은 안 싣는다(사유와 개수뿐) */
export function cisWhyNotSnapshot(): Record<string, unknown> | null {
  const day = kstDay();
  const v = cache.get(day);
  if (!v) return { day, 아직: "오늘 스캔 기록 없음" };
  const out: Record<string, unknown> = { day };
  for (const [id, s] of Object.entries(v.acc)) {
    const top = Object.entries(s.reasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([why, n]) => `${why} ×${n}`);
    out[id] = { 스캔: s.scans, 시장문닫힘: s.marketShut, 통과: s.passed, 계획: s.planned, 샀다: s.bought, 많은사유: top };
  }
  return out;
}

/** 며칠치를 모아 사유별로 — 화면·되짚기가 「이번 주 뭐 때문에 못 샀나」를 물을 때 */
export async function whyNotRange(days: string[]): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {};
  for (const d of days) {
    const v = await load(d).catch(() => null);
    if (!v) continue;
    for (const [id, s] of Object.entries(v.acc)) {
      const bag = (out[id] ??= {});
      for (const [why, n] of Object.entries(s.reasons)) bag[why] = (bag[why] ?? 0) + n;
    }
  }
  return out;
}
