import { peekRealtime } from "./realtimeHub.js";

/**
 * **거래원 실시간에 외국계 합계가 실려 오나 — 값을 맞춰서 알아낸다** (2026-10-15).
 *
 * 벤티지: "프로그램은 화면 안 열어놔도 쌓고 있잖아 얘는 왜?"
 *
 * 어제 「외국계는 조회(`ka10040`)에만 있다」고 답했는데, 그건 **문서를 보고** 한 말이지
 * 재 본 적이 없었다. 그래서 `0F` 프레임의 FID 번호를 세어 봤더니(health 「거래원필드」)
 * 우리가 안 쓰는 칸이 **스물일곱 개** 와 있었다 — 261~285, 337.
 *
 * ## 번호만으로는 모른다
 *
 * 여기서 문서를 찾아 「261이 외국계매도추정합일 것」이라고 적으면 **어제와 똑같은 실수**다.
 * 추측으로 메운 자리는 티가 안 나고, 틀리면 조용히 틀린 숫자를 그린다.
 *
 * **정답지가 이미 손에 있다.** 거래원 조회(`ka10040`)가 외국계 매도·매수 합계를 주고,
 * 같은 종목의 `0F` 프레임이 메모리에 있다. 그러니 **값을 맞춰 보면 된다** — 어느 칸이
 * 그 숫자와 같은지 세기만 하면, 번호의 뜻을 몰라도 그 칸이 무엇인지 알 수 있다.
 *
 * 여러 종목·여러 시점에서 같은 칸이 계속 맞으면 그건 우연이 아니다.
 *
 * ## ⚠️ 시각이 조금 어긋난다
 *
 * 조회로 받은 값은 그 조회 시점이고 프레임은 마지막 체결 시점이라, 장중에는 그 사이에
 * 몇 주가 더 거래된다. 그래서 **딱 맞음**과 **거의 맞음(0.3% 이내)**을 따로 센다 —
 * 딱 맞음이 하나라도 나오면 그 칸이 답이고, 거의 맞음만 쌓이면 「같은 뜻의 다른 시점」이다.
 *
 * ## 공짜다
 *
 * 조회를 한 건도 더 안 쓴다. 이미 받은 두 가지를 메모리에서 맞춰 볼 뿐이다.
 * 답이 나오면 이 파일은 지우고, 그 칸을 `realtimeStore` 의 `KEEP` 에 더하면
 * **외국계도 프로그램처럼 전 종목 하루 종일** 쌓인다.
 */

/** 우리가 이미 쓰는 칸 — 창구 다섯 자리 × (코드·수량·증감) */
const KNOWN = new Set(
  Array.from({ length: 5 }, (_, i) => [
    String(146 + i),
    String(156 + i),
    String(161 + i),
    String(166 + i),
    String(171 + i),
    String(176 + i),
  ]).flat(),
);

interface Hit {
  매도: number;
  매도근접: number;
  매수: number;
  매수근접: number;
  순매수: number;
  순매수근접: number;
}

const hits = new Map<string, Hit>();
let samples = 0;
let lastAt = "";

function near(a: number, b: number): "exact" | "near" | null {
  if (b === 0 || a === 0) return null;
  if (a === b) return "exact";
  return Math.abs(a - b) / Math.abs(b) <= 0.003 ? "near" : null;
}

function bump(fid: string, kind: keyof Hit): void {
  let h = hits.get(fid);
  if (!h) {
    if (hits.size >= 60) return;
    h = { 매도: 0, 매도근접: 0, 매수: 0, 매수근접: 0, 순매수: 0, 순매수근접: 0 };
    hits.set(fid, h);
  }
  h[kind] += 1;
}

/**
 * 거래원 조회가 끝날 때마다 불린다 — 그 종목의 `0F` 프레임과 맞춰 본다.
 * 터져도 거래원 화면이 멈추면 안 되므로 부르는 쪽에서 감싼다.
 */
export function noteFxFids(code: string, sell: number, buy: number): void {
  if (sell <= 0 && buy <= 0) return;
  const { store } = peekRealtime();
  if (!store) return;
  const bare = String(code).replace(/_(AL|NX)$/i, "");
  const f = store.getLatest("0F", bare);
  const v = f?.values;
  if (!v) return;
  samples += 1;
  lastAt = new Date().toISOString();
  const net = buy - sell;
  for (const [fid, raw] of Object.entries(v)) {
    if (KNOWN.has(fid)) continue;
    const n = Number(String(raw ?? "").replace(/[+,\s]/g, ""));
    if (!Number.isFinite(n) || n === 0) continue;
    const a = Math.abs(n);
    const s = near(a, sell);
    if (s) bump(fid, s === "exact" ? "매도" : "매도근접");
    const b = near(a, buy);
    if (b) bump(fid, b === "exact" ? "매수" : "매수근접");
    const t = near(a, Math.abs(net));
    if (t) bump(fid, t === "exact" ? "순매수" : "순매수근접");
  }
}

/** health.json 「외국계FID」 — 맞은 칸만. 종목코드도 값도 안 싣는다 */
export function fxFidSnapshot(): { 맞춰본횟수: number; 마지막: string; 칸: Record<string, Hit> } | null {
  if (samples === 0) return null;
  const 칸: Record<string, Hit> = {};
  for (const [fid, h] of [...hits.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    칸[fid] = h;
  }
  return { 맞춰본횟수: samples, 마지막: lastAt, 칸 };
}
