import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RealtimeFrame } from "./realtimeClient.js";

/**
 * **장운영구분 관측** (2026-09-04) — 키움이 직접 알려 주는 「지금 장이 어느 국면인가」.
 *
 * ## 왜 만들었나
 *
 * 벤티지가 키움 공식 저장소(8/27 공개)를 물어봐서 훑다가 찾았다. 실시간 타입 `0s` 가
 * **장운영구분(FID 215)** 과 **장시작예상잔여시간(FID 214)** 을 보내 준다.
 *
 * 우리는 지금 「평일 09:00~15:30」을 **다섯 군데에 각자 박아 뒀다** — 관심종목 알림
 * 스케줄러 · 거래원 자동수집 · 주문 시간창 · 시황 대시보드 장 상태 · 마감 뒤 정리.
 * 2026-09-14 KRX 애프터시장이 생기면 그 다섯을 다 찾아 고쳐야 하고, 제도가 또 바뀌면
 * 또 고쳐야 한다. **키움이 판단한 것을 받아 쓰면 그 일이 사라진다.**
 *
 * ## 그런데 지금은 「받아 쓰지」 않는다 — 적어 두기만 한다
 *
 * 벤티지: "이거 지금 적용하면 안되는거야?"
 *
 * 절반만 된다. 구독은 지금 켜도 되지만 **판단을 넘기는 건 아직 안 된다** — 우리가
 * `215` 의 **값**을 모르기 때문이다. 「0 이 장전이고 2 가 장중」 같은 표를 추측으로
 * 박으면, 그게 틀렸을 때 **장중에 알림이 멈추거나 장 끝난 뒤에 주문이 나간다.**
 * 이 프로젝트에서 제일 하면 안 되는 짓이 그거다(`realtimeClient.ts` 머리글:
 * "추측하지 않고 서버가 하는 말을 그대로 기록한다").
 *
 * 그래서 이 모듈은 **관측기**다. 오는 값을 그대로 적고 화면에 보여 준다. 며칠 지나면
 * 08:30·09:00·15:20·15:30·15:40·16:00·18:00 에 무슨 값이 오는지 표가 저절로 만들어진다.
 * **9/14 개편 작업 때 그 표를 보고 한 번에 갈아탄다** — 그때는 추측이 아니라 관측이다.
 * 애프터시장이 새 값을 들고 와도 여기 기록에 남으므로 그것까지 같이 본다.
 *
 * 켜 두는 값이 싸다: 종목과 무관한 구독 하나라 정원(190종목)을 안 먹고, 프레임도
 * 국면이 바뀔 때만 온다(하루 예닐곱 줄).
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FILE = join(DATA_DIR, "marketPhase.jsonl");

/** 관측 한 줄 — 해석하지 않은 날것 */
export interface PhaseObservation {
  /** 우리 시계 (ISO) */
  at: string;
  /** FID 215 장운영구분 — **뜻은 아직 모른다.** 온 그대로 */
  code: string;
  /** FID 20 체결시간 (HHMMSS) — 키움 시계 */
  time: string;
  /** FID 214 장시작예상잔여시간 */
  leftToOpen: string;
  /** 어느 종목/항목으로 왔나 */
  item: string;
  /** 혹시 다른 FID 도 오면 통째로 남긴다 — 나중에 필요해진다 */
  values: Record<string, string>;
}

const MAX_KEEP = 400;
const seen: PhaseObservation[] = [];
/** 같은 값이 연달아 오면 한 줄만 — 국면은 바뀔 때만 뜻이 있다 */
let lastKey = "";

/** 우리가 아는 이름은 아직 없다. 관측이 쌓이면 여기에 채운다 (2026-09-14 작업) */
const KNOWN: Record<string, string> = {};

export function phaseLabel(code: string): string | null {
  return KNOWN[code] ?? null;
}

function kstStamp(d = new Date()): string {
  return new Date(d.getTime() + 9 * 3600_000).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * 프레임 하나를 본다. `0s` 가 아니면 그냥 지나간다.
 *
 * 실시간 허브가 **모든** 프레임을 흘려 보내므로 여기서 걸러야 한다 — 구독이 여러
 * 종류라 타입 검사가 첫 줄이어야 싸다.
 */
export function notePhaseFrame(f: RealtimeFrame): void {
  for (const d of f.data ?? []) {
    if (d.type !== "0s") continue;
    const v = d.values ?? {};
    const code = String(v["215"] ?? "").trim();
    if (!code) continue;
    const time = String(v["20"] ?? "").trim();
    const key = `${code}|${time}`;
    if (key === lastKey) continue;
    lastKey = key;
    const row: PhaseObservation = {
      at: new Date().toISOString(),
      code,
      time,
      leftToOpen: String(v["214"] ?? "").trim(),
      item: String(d.item ?? ""),
      values: v,
    };
    seen.push(row);
    if (seen.length > MAX_KEEP) seen.splice(0, seen.length - MAX_KEEP);
    console.log(`[phase] 장운영구분 ${code} · 키움시계 ${time} · 우리시계 ${kstStamp()}`);
    void append(row);
  }
}

async function append(row: PhaseObservation): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.appendFile(FILE, JSON.stringify(row) + "\n", "utf8");
  } catch {
    /* 기록에 실패해도 서비스는 돈다 — 이건 관측 노트지 동작에 쓰이는 값이 아니다 */
  }
}

/** 화면·시스가 보는 것 — 메모리에 든 것부터, 없으면 파일에서 */
export async function readPhaseLog(limit = 200): Promise<PhaseObservation[]> {
  if (seen.length >= limit) return seen.slice(-limit).reverse();
  try {
    const lines = (await fs.readFile(FILE, "utf8")).split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l) as PhaseObservation;
        } catch {
          return null;
        }
      })
      .filter((r): r is PhaseObservation => r !== null)
      .reverse();
  } catch {
    return [...seen].reverse();
  }
}

/**
 * 지금 관측된 국면. **아직 아무도 이걸로 판단하지 않는다** — 화면에 보여 주기만 한다.
 *
 * 9/14 에 갈아탈 때 `isMarketHours` 류가 이 값을 먼저 보고, 없거나 오래됐으면 지금의
 * 시간표로 떨어지는 모양이 된다. 그 전환은 **관측 표가 채워진 뒤** 한 번에 한다.
 */
export function currentPhase(): { code: string; label: string | null; at: string; ageSec: number } | null {
  const last = seen[seen.length - 1];
  if (!last) return null;
  return {
    code: last.code,
    label: phaseLabel(last.code),
    at: last.at,
    ageSec: Math.floor((Date.now() - new Date(last.at).getTime()) / 1000),
  };
}

/** 관측된 값들을 한 번에 — 「어떤 코드가 몇 번, 몇 시에」. 표를 만들 때 이걸 본다 */
export async function phaseSummary(): Promise<
  { code: string; label: string | null; count: number; times: string[]; firstAt: string; lastAt: string }[]
> {
  const rows = (await readPhaseLog(400)).slice().reverse();
  const by = new Map<string, { count: number; times: string[]; firstAt: string; lastAt: string }>();
  for (const r of rows) {
    const cur = by.get(r.code);
    if (cur) {
      cur.count += 1;
      cur.lastAt = r.at;
      /* 시각은 앞의 다섯 개만 — 08:30·09:00 처럼 늘 같은 자리면 그것으로 충분하다 */
      if (cur.times.length < 5 && r.time) cur.times.push(r.time);
    } else {
      by.set(r.code, { count: 1, times: r.time ? [r.time] : [], firstAt: r.at, lastAt: r.at });
    }
  }
  return [...by.entries()]
    .map(([code, v]) => ({ code, label: phaseLabel(code), ...v }))
    .sort((a, b) => a.code.localeCompare(b.code));
}
