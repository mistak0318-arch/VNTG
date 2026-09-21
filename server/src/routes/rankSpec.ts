import { Router } from "express";
import { cumulativeRank } from "../cumulativeRank.js";
import type { KiwoomClient } from "../kiwoomClient.js";
import { COMMON_PARAMS, findSpec, specGroups, type RankSpec } from "../rankSpecs.js";
import { getMarketSnapshot } from "../marketSnapshot.js";
import { latestRegularCloses } from "../dailyCloses.js";
import { bare, extras, toNum } from "../rankExtras.js";
import { getStockIndex } from "../stockListCache.js";
import { flowRank, flowSums, SUBJECT_LABEL, type FlowSubject, twinFromSpans } from "../dailyStore.js";
import { buzzDetail, buzzMany, markEntered, clampDays } from "../inquiryBuzz.js";
import { cumulative, noteLiveSample, samplerStatus } from "../inquirySampler.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **새벽에 0 으로 초기화된 순위 대신 어제 마감 값** (2026-09-10 — 벤티지 "어제 그 전날
 * 데이터들 … 오늘 오전 일곱 시까지는 들고 있어줘라 … 지금 여섯 시 사십육 분인데 모든
 * 데이터가 초기화돼 있는 것 같네").
 *
 * 키움 순위 TR 은 날이 바뀌면(대략 06시) 거래대금·거래량·등락률을 **0 으로** 준다 —
 * 종목 순서만 어제 것이고 값은 빈 껍데기다. 그 화면은 아무 말도 안 한다.
 *
 * 마지막으로 **값이 있던 응답**을 조회 키(명세·시장·거래소·선택·건수)마다 파일에 남겨 두고,
 * 응답이 빈 껍데기(줄의 대부분이 거래대금 0·등락률 0)면 그것을 대신 준다. 언제까지가
 * 아니라 **값이 다시 생길 때까지** — 08시 NXT 프리마켓이 열리면 거래대금이 붙기 시작하고
 * 그때부터 다시 새 값이다. 파일이라 배포·재시작에도 남는다.
 */
const here = dirname(fileURLToPath(import.meta.url));
const LAST_DIR = join(here, "..", "..", "data", "rankLast");

function lastFile(key: string): string {
  return join(LAST_DIR, `${key.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
}

/* ── 당일 봉 (2026-09-22) ─────────────────────────────────────────────── */

/** 한 종목의 오늘 봉 — 시·고·저·현재가·전일종가 */
export interface DayCandle {
  o: number;
  h: number;
  l: number;
  c: number;
  /** 전일 종가 — 봉을 어디에 놓을지(위/아래)와 색을 정한다 */
  pc: number;
}

/**
 * **`ka10095` 로 시·고·저를 받는다** — 한 번에 여러 종목(`|`).
 *
 * 순위 TR 은 이 값을 안 준다(ka10032 실측: 칸 13개뿐). 50종목씩 끊어 부르고 10초 캐시를 둔다 —
 * 화면이 자동 새로고침으로 자주 물어도 조회가 그만큼 늘지 않게. 100줄이면 조회 두 번이다.
 */
const candleCache = new Map<string, { at: number; v: Map<string, DayCandle> }>();

async function candles(client: KiwoomClient, codes: string[]): Promise<Map<string, DayCandle>> {
  const want = [...new Set(codes.filter((c) => /^[0-9A-Z]{6}$/i.test(c)))];
  const key = want.slice().sort().join(",");
  const hit = candleCache.get(key);
  if (hit && Date.now() - hit.at < 10_000) return hit.v;
  const out = new Map<string, DayCandle>();
  const abs = (v: unknown): number => Math.abs(Number(String(v ?? "").replace(/[+,\s]/g, "")) || 0);
  for (let i = 0; i < want.length; i += 50) {
    const part = want.slice(i, i + 50);
    const { data } = await client.request<Record<string, unknown>>("/api/dostk/stkinfo", "ka10095", {
      stk_cd: part.map((c) => `${c}_AL`).join("|"),
    });
    for (const r of (data.atn_stk_infr ?? []) as Record<string, unknown>[]) {
      const code = String(r.stk_cd ?? "").replace(/_(AL|NX)$/i, "");
      const o = abs(r.open_pric);
      const h = abs(r.high_pric);
      const l = abs(r.low_pric);
      const c = abs(r.cur_prc);
      const pc = abs(r.base_pric);
      /* 하나라도 0 이면 봉을 못 그린다 — 안 그리는 편이 거짓 그림보다 낫다 */
      if (code && o > 0 && h > 0 && l > 0 && c > 0) out.set(code, { o, h, l, c, pc: pc > 0 ? pc : o });
    }
  }
  candleCache.set(key, { at: Date.now(), v: out });
  if (candleCache.size > 30) {
    const oldest = [...candleCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) candleCache.delete(oldest[0]);
  }
  return out;
}

/** 줄의 대부분이 거래대금 0·등락률 0 — 새 날의 빈 껍데기 */
function looksReset(rows: { tv: number | null; flu_rt?: unknown }[]): boolean {
  if (rows.length < 5) return false;
  const dead = rows.filter((r) => !(r.tv && r.tv > 0) && !(Number(r.flu_rt) !== 0 && Number.isFinite(Number(r.flu_rt)))).length;
  return dead >= rows.length * 0.8;
}

async function saveLast(key: string, rows: unknown[]): Promise<void> {
  try {
    await mkdir(LAST_DIR, { recursive: true });
    await writeFile(lastFile(key), JSON.stringify({ at: new Date().toISOString(), rows }), "utf8");
  } catch {
    /* 못 남겨도 지금 응답은 그대로 나간다 */
  }
}

async function loadLast(key: string): Promise<{ at: string; rows: unknown[] } | null> {
  try {
    return JSON.parse(await readFile(lastFile(key), "utf8")) as { at: string; rows: unknown[] };
  } catch {
    return null;
  }
}

function kstStamp(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return `${d.toISOString().slice(5, 10).replace("-", "/")} ${d.toISOString().slice(11, 16)}`;
}

/**
 * 시세분석 — 레지스트리에 등록된 순위 조회를 하나의 라우트로 처리한다.
 *
 * 순위마다 라우트를 만들면 같은 코드를 계속 복사하게 된다.
 * 명세(rankSpecs.ts)만 늘리면 화면까지 자동으로 붙는 구조로 뒀다.
 */

/**
 * KRX 정규장이 이미 시작했나 (평일 09:00 KST 이후).
 *
 * 마감 뒤에도 참이다 — 「오늘 KRX 값이 만들어졌나」를 묻는 것이지 지금 열려 있는지를
 * 묻는 게 아니다. 09시 전이면 KRX 자리에 있는 건 **장전 시간외종가**뿐이다.
 */
function krxSessionStarted(at = Date.now()): boolean {
  const d = new Date(at);
  const kst = new Date(d.getTime() + (9 * 60 + d.getTimezoneOffset()) * 60_000);
  if (kst.getDay() === 0 || kst.getDay() === 6) return false;
  return kst.getHours() * 60 + kst.getMinutes() >= 9 * 60;
}

function mapRow(row: Record<string, unknown>, spec: RankSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {
    code: bare(row.stk_cd),
    name: String(row.stk_nm ?? "").trim(),
  };
  for (const c of spec.columns) {
    // 이름은 위에서 이미 넣었고, 나머지는 형에 맞춰 변환한다
    if (c.key === "stk_nm") continue;
    /* 응답 이름이 다르면(`src`) 거기서 읽어 우리 이름으로 낸다 */
    const raw = row[c.src ?? c.key];
    const n = toNum(raw);
    /*
     * ⚠️ **가격은 부호를 떼서 내보낸다.**
     *
     * 키움은 하락 종목의 현재가를 `-52500` 처럼 **음수로** 준다(하락 표시 관행이다).
     * 그걸 그대로 흘리고 있었다 — 거래대금 상위 100줄 중 **50줄이 음수 가격**이었다.
     * 시세분석 화면은 그리면서 `Math.abs` 를 해 눈에 안 띄었지만, 이 응답을 쓰는
     * 다른 코드는 −52,500원을 그대로 받는다. **화면에서 가려서 없는 척하면 안 된다.**
     *
     * 여기서 부호를 떼도 잃는 게 없다 — 오르내림은 `flu_rt` 가 말한다.
     */
    out[c.key] = c.type === "text" ? String(raw ?? "") : c.type === "price" && n !== null ? Math.abs(n) : n;
  }
  return out;
}

/**
 * **기간 선택지는 한 벌뿐이다** (2026-09-09).
 *
 * 벤티지: "5일 10일 20일 이렇게 표현해줘 다른 부분(주포 순매수, 외국인 순매수 등)도
 * 점검해서 동일한 기준으로 해주고."
 *
 * 점검해 보니 표기(「N일」)는 이미 같았는데 **목록이 갈려 있었다** — 누적등락률은
 * `3·5·10·20·60`, 순매수 계열은 `1·5·10·20·60`. 같은 화면에서 조회를 옮기면 첫 단추가
 * 3일이었다 1일이었다 했다. 곳마다 목록을 적어 두면 이렇게 갈린다.
 *
 * 합집합으로 세운다 — 쓰던 기간이 하나도 안 사라진다. 기본값은 둘 다 5일로 같았다.
 */
const SPAN_OPTIONS = [
  { value: "1", label: "1일" },
  { value: "3", label: "3일" },
  { value: "5", label: "5일" },
  { value: "10", label: "10일" },
  { value: "20", label: "20일" },
  { value: "60", label: "60일" },
];

/** 화면이 고르는 기간 — 그 밖의 값은 안 받는다 */
const SPAN_VALUES = SPAN_OPTIONS.map((o) => Number(o.value));

/**
 * **어느 순위에나 수급을 얹는다** (2026-09-09).
 *
 * 벤티지: "수급 5일, 10일, 20일 외국인 기관 주포 이런 애들 수급, 그리고 거래대금,
 * 시가총액 이런 것도 적용해서 넣어줘. 현재 시세 분석에 이거 안 붙어 있는 애들도 있잖아."
 *
 * 시가총액·거래대금은 `extras()` 가 이미 모든 줄에 붙이고 있었다. 수급은 없었다 —
 * 순위 TR 이 안 주니까. 원장에서 더한다(조회 0회).
 *
 * **세 기간을 한꺼번에 준다** (2026-09-09 저녁 — 벤티지 "외국인 주포 10일 20일도
 * 추가하자"). 처음엔 화면이 기간 하나를 골라 `flow=` 로 보냈는데, 5·10·20일을 나란히
 * 놓고 견주는 게 쓰는 방식이었다. 원장은 종목당 한 번 읽고(캐시) 창만 셋을 자르므로
 * 세 번이 한 번과 값이 같다. 줄마다 `flow: { "5": {...}, "10": {...}, "20": {...} }` —
 * 각각 `fgn·trust·pen·samo·smart`(억원)와 `days`(실제 더한 날). 원장이 없는 종목은
 * 값이 `null` — 「모른다」를 0 으로 적지 않는다.
 */
const FLOW_SPANS = [5, 10, 20] as const;

async function withFlow<T extends { code: string }>(rows: T[]): Promise<T[]> {
  const codes = rows.map((r) => r.code);
  const sums = await Promise.all(FLOW_SPANS.map((span) => flowSums(codes, span).catch(() => new Map())));
  return rows.map((r) => {
    const flow: Record<string, unknown> = {};
    FLOW_SPANS.forEach((span, i) => {
      const f = sums[i].get(r.code);
      flow[String(span)] = {
        fgn: f?.fgn ?? null,
        trust: f?.trust ?? null,
        pen: f?.pen ?? null,
        samo: f?.samo ?? null,
        smart: f?.smart ?? null,
        days: f?.days ?? 0,
      };
    });
    /* 🧲 판정을 서버에서 붙인다 — 웹이 따로 셀 필요가 없다(정의 두 곳 문제, 2026-09-16) */
    const spans = FLOW_SPANS.map((span, i) => ({ fgn: sums[i].get(r.code)?.fgn ?? null, smart: sums[i].get(r.code)?.smart ?? null }));
    return { ...r, flow, ...twinFromSpans(spans) };
  });
}

export function createRankSpecRouter(client: KiwoomClient): Router {
  const router = Router();

  /** 트리에 그릴 목록 */
  router.get("/specs", (_req, res) => {
    res.json({ groups: specGroups() });
  });

  /**
   * 순위 조회.
   * `market` 은 000 전체 / 001 코스피 / 101 코스닥,
   * `exchange` 는 1 KRX / 2 NXT / 3 통합 (명세가 허용한 조회에서만).
   */
  /**
   * 누적등락률 상위 — **키움에 없어서 우리가 계산한다.**
   *
   * 100종목 일봉을 받아야 해서 처음 한 번은 30초쯤 걸린다. 그 뒤 10분은 캐시다.
   */
  router.get("/cumulative", async (req, res, next) => {
    try {
      const market = typeof req.query.market === "string" ? req.query.market : "000";
      /*
       * ⚠️ 바닥이 2 였다 (2026-09-09). 기간 선택지를 한 벌로 합치면서 1일이 생겼는데,
       * 그대로 두면 **단추는 「1일」이라 적고 속으로는 2일을 재는** 꼴이 된다. 화면이
       * 말하는 것과 서버가 세는 것이 다르면 그건 조용한 거짓말이다.
       * 하루 누적은 곧 전일 대비라 계산도 멀쩡하다(`cs[len-1-days]`, 봉 두 개면 된다).
       */
      const days = Math.min(Math.max(Number(req.query.days) || 5, 1), 60);
      /*
       * **모집단을 500까지 연다** (2026-09-02). 예전 상한이 200 이었던 것은
       * 종목마다 일봉을 받아 260ms 씩 쉬어야 했기 때문이다 — 200종목이면 52초.
       * 이제 저장해 둔 전종목 일봉을 읽으므로 500도 1초대다.
       */
      const universe = Math.min(Math.max(Number(req.query.universe) || 100, 20), 500);
      const r = await cumulativeRank(client, market, days, universe);

      /*
       * ## **시세분석의 다른 순위와 같은 모양으로 준다** (2026-09-02)
       *
       * 벤티지: "이 버튼에만 신호등 켜기 메뉴가 안보이네" / "그리고 필터 메뉴도
       * 넣어줘"
       *
       * 이 조회만 화면에서 **다른 컴포넌트**로 그려지고 있었다. 그래서 신호등
       * 켜기·필터·열 순서·쪽 넘김이 전부 없었다 — 없는 게 아니라 **그 자리에
       * 안 붙은** 것이다.
       *
       * `spec` 을 같이 주면 화면이 다른 순위와 똑같이 그린다. 화면을 한 벌로
       * 만드는 편이 낫다 — 두 벌이면 한쪽만 고쳐지는 일이 반드시 생긴다.
       *
       * ⚠️ 행의 키 이름을 `spec.columns` 에 맞춘다. 서버가 `cumRate`·`todayRate`
       * 처럼 부르던 것을 그대로 두고 열 정의만 그 이름으로 적는다.
       */
      res.json({
        ...r,
        spec: {
          key: "cumulative",
          label: `누적등락률 상위 (${days}일)`,
          columns: [
            { key: "cur_prc", label: "현재가", type: "num" },
            { key: "todayRate", label: "오늘", type: "num" },
            { key: "r3", label: "3일", type: "num" },
            { key: "cumRate", label: `${days}일 누적`, type: "num" },
            { key: "r10", label: "10일", type: "num" },
            { key: "r20", label: "20일", type: "num" },
            { key: "r60", label: "60일", type: "num" },
            { key: "trde_prica", label: "거래대금", type: "num" },
          ],
          exchange: false,
          choices: [
            {
              param: "days",
              label: "기간",
              def: "5",
              options: SPAN_OPTIONS,
            },
          ],
          note: r.note,
        },
        exchange: "3",
        /*
         * 화면이 읽는 키로 맞춰 다시 낸다 — 값 자체는 그대로다.
         *
         * ⚠️ **`extras` 를 빼먹으면 화면이 터진다** (2026-09-02 실측:
         * `Cannot read properties of undefined (reading 'toFixed')`). 시세분석
         * 표는 시가총액·회전율 칸을 늘 그리는데 그건 순위 응답이 실어 주는
         * 값이다. 다른 순위 경로는 전부 `extras()` 를 붙이고 있었고 여기만
         * 안 붙어 있었다 — 이 조회가 원래 다른 화면으로 그려졌기 때문이다.
         */
        rows: await (async () => {
          const index = await getStockIndex(client).catch(() => new Map());
          return withFlow(r.rows.map((x, i) => {
            const ex = extras(
              { cur_prc: String(x.price), now_trde_qty: "0", stk_cd: x.code },
              index.get(x.code),
            );
            return {
              ...x,
              ...ex,
              rank: i + 1,
              cur_prc: x.price,
              flu_rt: x.todayRate,
              trde_prica: x.tradeValue,
            };
          }));
        })(),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * **시가총액 상위** — 키움에 없어서 우리가 세운다.
   *
   * 순위 TR 에는 시가총액 순위가 없다. 그런데 「그 종목이 얼마짜리 회사인가」로 줄을 세워
   * 보는 일은 실제로 잦다 — 같은 +5% 라도 3천억과 30조는 다른 사건이다.
   *
   * 재료는 이미 있다. 시황 스냅샷이 업종 구성종목을 모아 두면서 **시가총액을 같이** 들고
   * 있다. 새로 조회하지 않고 그걸 세운다.
   *
   * ⚠️ **스냅샷에 없는 종목은 못 센다.** 스냅샷은 업종 구성종목으로 만드는데 키움이
   * 일부 업종의 구성종목을 안 주고 ETF·리츠는 업종에 안 잡힌다. 시총 상위는 대형주라
   * 거의 다 들어오지만, 「전 종목을 다 본 순위」는 아니라는 걸 화면에 적어 둔다.
   */
  /**
   * **정규장 종가 대비 장외 괴리율** (2026-09-14 — 벤티지: "이제 괴리율 계산을 KRX 나 NXT 기준에서
   * 정규장·애프터장으로 해야 되지 않니? 지금 저건 의미가 없어 보이는데").
   *
   * ## 왜 KRX 대 NXT 가 아닌가
   *
   * 처음엔 키움 MTS 「KRX/NXT 괴리율 순위」를 그대로 따라 두 거래소 가격을 맞댔다. 그런데 애프터마켓이
   * 생긴 오늘부터 16:00~20:00 은 **KRX 도 NXT 도 둘 다 살아 있다.** 16:09 에 재 보니 겹친 39종목의
   * 중앙값 0%, 최대 0.25% — 차익거래가 눌러서 **아무것도 안 보인다.** 벤티지 말이 맞다.
   *
   * 트레이더가 장외에서 보고 싶은 것은 **「정규장이 끝난 뒤 얼마나 움직였나」**다. 공시·뉴스가 장 뒤에
   * 나오면 그게 여기서 먼저 드러난다. 그래서 기준을 거래소가 아니라 **시간**으로 바꾼다.
   *
   * ## 기준선 하나로 아침과 저녁을 같이 본다
   *
   *   08:00~09:00  NXT 프리마켓   vs **앞 장의 정규장 종가**
   *   15:30~16:00  NXT (KRX 공백) vs **오늘 정규장 종가**
   *   16:00~20:00  KRX 애프터     vs **오늘 정규장 종가**
   *   20:00~ 다음날 08:00  장외 마감값 vs 오늘 정규장 종가 — 「오늘 장 뒤에 얼마나 갔나」 정리
   *   09:00~15:30  정규장 중 — 이 순위는 뜻이 없다. 등락률 순위를 보면 된다
   *
   * 기준선은 15:40 에 찍어 두는 **정규장 종가 파일**(`data/regularCloses`)이다. 키움 등락률은 전일 종가
   * 대비라 오늘 정규장 종가를 모른다 — 우리가 찍은 값이 유일한 기준이다. 파일이 없으면 지어내지 않고
   * 빈 목록과 이유를 돌려준다.
   *
   * ## 어느 거래소 가격을 쓰나
   *
   * 16:00~20:00 은 KRX 애프터가 본 시장이라 KRX 를 먼저 보고, KRX 에서 안 돈 종목(ETF·관리 등 애프터
   * 제외)은 NXT 로 채운다. 그 밖의 시간은 NXT 만 돈다. 줄마다 어느 쪽 값인지 `src` 로 적는다.
   * 줄에 붙어 오는 `nxtPrice` 는 **통합 가격**이라 16시 뒤엔 KRX 체결이 섞인다 — 안 쓴다.
   *
   * `/:key` 보다 **위에** 있어야 한다.
   */
  router.get("/after-gap", async (req, res, next) => {
    try {
      const market = ["000", "001", "101"].includes(String(req.query.market)) ? String(req.query.market) : "000";
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 20), 300);
      const d = new Date(Date.now() + 9 * 3600_000);
      const today = d.toISOString().slice(0, 10);
      const min = d.getUTCHours() * 60 + d.getUTCMinutes();
      const wd = d.getUTCDay();
      const weekend = wd === 0 || wd === 6;

      type Phase = "pre" | "regular" | "gap" | "after" | "closed";
      const phase: Phase = weekend
        ? "closed"
        : min >= 480 && min < 540
          ? "pre"
          : min >= 540 && min < 930
            ? "regular"
            : min >= 930 && min < 960
              ? "gap"
              : min >= 960 && min < 1200
                ? "after"
                : "closed";
      const PHASE_LABEL: Record<Phase, string> = {
        pre: "NXT 프리마켓 — 앞 장 정규장 종가 대비",
        regular: "정규장 중",
        gap: "15:30~16:00 공백 — NXT 가 오늘 정규장 종가 대비",
        after: "애프터마켓 — 오늘 정규장 종가 대비",
        closed: "장 뒤 — 오늘 정규장 종가 대비 마감값",
      };

      const spec = {
        key: "after-gap",
        label: "정규장 대비 장외",
        columns: [
          { key: "rank", label: "순위", type: "num" },
          { key: "base", label: "정규장 종가", type: "price" },
          { key: "cur_prc", label: "지금", type: "price" },
          /* 부호가 뜻이다 — 양수면 장 뒤에 올랐다 */
          { key: "gap", label: "장외 괴리", type: "pct" },
        ],
        exchange: false,
        note:
          "정규장이 끝난 뒤(또는 장 전) 얼마나 움직였나입니다. 기준은 정규장 종가 — 저녁엔 오늘, 아침엔 앞 장. " +
          "16:00~20:00 은 KRX 애프터 값, 그 밖의 시간과 애프터 제외 종목(ETF·관리 등)은 NXT 값을 씁니다. " +
          "정규장 중(09:00~15:30)에는 뜻이 없어 비워 둡니다 — 등락률 순위를 보세요.",
      };

      if (phase === "regular") {
        res.json({ spec, market, exchange: "3", phase, phaseLabel: PHASE_LABEL[phase], rows: [], empty: "정규장 중에는 장외 괴리가 없습니다 — 15:30 뒤에 다시 여세요." });
        return;
      }
      /* 아침은 앞 장, 그 밖엔 오늘. 15:30~15:40 은 오늘 파일이 아직 없다 — 앞 장으로 떨어지면 틀린 기준이다 */
      const wantToday = phase !== "pre";
      const found = await latestRegularCloses(today);
      if (!found || (wantToday && found.date !== today)) {
        res.json({
          spec,
          market,
          exchange: "3",
          phase,
          phaseLabel: PHASE_LABEL[phase],
          rows: [],
          empty: wantToday ? "오늘 정규장 종가를 아직 못 찍었습니다 — 15:40 에 찍힙니다." : "기준이 될 정규장 종가 파일이 없습니다.",
        });
        return;
      }
      const base = found.closes;

      const LIST = "trde_prica_upper";
      const pull = async (stex: string, pages: number) => {
        const out: Record<string, unknown>[] = [];
        let contYn = "N";
        let nextKey = "";
        for (let page = 0; page < pages; page += 1) {
          const r = await client.request<Record<string, unknown>>(
            "/api/dostk/rkinfo",
            "ka10032",
            { ...COMMON_PARAMS, mrkt_tp: market, stex_tp: stex },
            page === 0 ? {} : { contYn, nextKey },
          );
          const got = Array.isArray(r.data[LIST]) ? (r.data[LIST] as Record<string, unknown>[]) : [];
          if (got.length === 0) break;
          out.push(...got);
          contYn = r.contYn;
          nextKey = r.nextKey;
          if (contYn !== "Y" || !nextKey) break;
        }
        return out;
      };
      const [nxtRows, krxRows] = await Promise.all([pull("2", 2), phase === "after" || phase === "closed" ? pull("1", 3) : Promise.resolve([])]);

      type Px = { price: number; row: Record<string, unknown> };
      const nxtOf = new Map<string, Px>();
      const krxOf = new Map<string, Px>();
      for (const r of nxtRows) {
        const px = toNum(r.cur_prc);
        if (px !== null && px !== 0) nxtOf.set(bare(r.stk_cd), { price: Math.abs(px), row: r });
      }
      for (const r of krxRows) {
        const px = toNum(r.cur_prc);
        if (px !== null && px !== 0) krxOf.set(bare(r.stk_cd), { price: Math.abs(px), row: r });
      }
      /*
       * **어느 값을 쓰나** — KRX 가 장 뒤에 **움직였으면** KRX(본 시장), 아니면 NXT.
       *
       * KRX 값이 정규장 종가와 같다는 건 애프터에서 안 돌았다는 뜻이다. 관리·투자경고처럼 KRX 애프터에
       * 안 들어가는 종목이 여기 걸리는데, 그 종목도 NXT 에선 움직일 수 있다. KRX 를 무조건 먼저 쓰면
       * 그 움직임이 **0 으로 가려진다.** 16:31 에 재 보니 KRX·NXT 가 둘 다 돈 종목은 차이가 0.25% 안쪽이라
       * 어느 쪽을 써도 뜻이 같다 — 갈리는 건 한쪽이 멈춘 종목뿐이고, 그땐 움직인 쪽이 사실이다.
       */
      const pick = new Map<string, { price: number; src: "KRX" | "NXT"; row: Record<string, unknown> }>();
      for (const code of new Set([...nxtOf.keys(), ...krxOf.keys()])) {
        const b = base.get(code);
        const k = krxOf.get(code);
        const n = nxtOf.get(code);
        if (k && (!n || (b !== undefined && k.price !== b))) pick.set(code, { price: k.price, src: "KRX", row: k.row });
        else if (n) pick.set(code, { price: n.price, src: "NXT", row: n.row });
      }

      const index = await getStockIndex(client).catch(() => new Map());
      const rows = [...pick.entries()]
        .map(([code, p]) => {
          const b = base.get(code);
          if (!b || b <= 0) return null;
          const gap = Math.round(((p.price - b) / b) * 10000) / 100;
          const ex = extras({ ...p.row, cur_prc: String(p.price) }, index.get(code));
          return {
            code,
            name: String(p.row.stk_nm ?? "").trim(),
            base: b,
            cur_prc: p.price,
            gap,
            absGap: Math.abs(gap),
            /*
             * 등락률은 **키움이 준 전일 대비 값 그대로**다. 괴리로 덮지 않는다 — 화면이 이 칸에 실시간
             * 등락률을 덧씌우므로 덮으면 한 칸에 두 뜻이 섞인다. 장외 괴리는 `gap` 칸 하나가 말한다.
             */
            flu_rt: toNum(p.row.flu_rt),
            src: p.src,
            ...ex,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort((a, b) => b.absGap - a.absGap)
        .slice(0, limit)
        .map((x, i) => ({ ...x, rank: i + 1 }));

      res.json({
        spec: { ...spec, note: `${PHASE_LABEL[phase]} · 기준 ${found.date} 정규장 종가. ` + spec.note },
        market,
        exchange: "3",
        phase,
        phaseLabel: PHASE_LABEL[phase],
        baseDate: found.date,
        rows: await withFlow(rows),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/market-cap", async (req, res, next) => {
    try {
      const market = ["000", "001", "101"].includes(String(req.query.market))
        ? String(req.query.market)
        : "000";
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 20), 500);
      const snap = await getMarketSnapshot(client);
      const index = await getStockIndex(client).catch(() => new Map());

      const want = market === "001" ? "kospi" : market === "101" ? "kosdaq" : null;
      const rows = [...snap.byCode.values()]
        .filter((s) => s.marketCap !== null && s.marketCap > 0)
        .filter((s) => (want ? s.market === want : true))
        .sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0))
        .slice(0, limit)
        .map((s, i) => {
          const e = index.get(s.code);
          const ex = extras({ cur_prc: String(s.price), now_trde_qty: "0", stk_cd: s.code }, e);
          return {
            code: s.code,
            name: s.name,
            rank: i + 1,
            cur_prc: s.price,
            flu_rt: s.changeRate,
            ...ex,
            /* 스냅샷 쪽 시총이 더 믿을 만하다 — 키움이 직접 준 값이다 */
            cap: s.marketCap,
            /* 거래대금도 스냅샷의 어림값으로 — 이 순위엔 거래량이 없어 `extras` 가 못 낸다 (2026-09-09) */
            tv: s.tradeValue ?? null,
            tvEst: true,
          };
        });

      res.json({
        spec: {
          key: "market-cap",
          label: "시가총액 상위",
          columns: [
            { key: "rank", label: "순위", type: "num" },
            { key: "cur_prc", label: "현재가", type: "num" },
            { key: "flu_rt", label: "등락률", type: "num" },
          ],
          exchange: false,
          note:
            "시황 스냅샷에서 세운 순위입니다 — 키움 순위 조회에는 시가총액 순위가 없습니다. " +
            "스냅샷은 업종 구성종목으로 만들어서 ETF·리츠와 일부 업종 종목이 빠집니다.",
        },
        market,
        exchange: "3",
        rows: await withFlow(rows),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * **주체별 순매수 상위** (2026-09-02) — 원장에서 세운다. **조회 0회.**
   *
   * 벤티지: "외국인순매수 상위 (기간 : 1일, 5일, 10일, 20일, 60일), 주포 순매수
   * 상위 (투신+연기금+사모) (기간 : 1일, 5일, 10일, 20일, 60일)"
   *
   * ## 왜 원장인가
   *
   * 키움 순위 TR 에도 투자자별 매매상위가 있지만 **그날 하루치**다. 「닷새 동안
   * 누가 얼마나 샀나」는 못 묻는다. 그런데 실측에서 성적을 가른 것은 연속성이
   * 아니라 **기간 합계**였다 — 닷새 내리 1억씩 산 종목보다 사흘 사고 하루 쉬고
   * 이틀 산 500억이 미는 쪽이다.
   *
   * 전종목 일별 원장이 매일 쌓이므로 그걸 더하면 된다. 조회가 0회이고 기간도
   * 마음대로 잡을 수 있다 — 그게 이 경로의 존재 이유다.
   *
   * ⚠️ **원장이 얕으면 기간이 짧아진다.** 60일을 물어도 원장이 40일뿐이면 40일치
   * 합이다. `days` 로 실제 더한 날 수를 같이 주고 화면이 그걸 적는다 — 「60일」이라
   * 적어 놓고 40일을 재면 그건 조용한 거짓말이다.
   *
   * `/:key` 보다 **위에** 있어야 한다(아래 주석 참고).
   */
  router.get("/flow/:subject", async (req, res, next) => {
    try {
      const subject = String(req.params.subject) as FlowSubject;
      if (!(subject in SUBJECT_LABEL)) {
        res.status(404).json({ error: "없는 투자자 주체입니다." });
        return;
      }
      /* 화면이 고르는 기간 — 그 밖의 값은 안 받는다 */
      const span = SPAN_VALUES.includes(Number(req.query.span)) ? Number(req.query.span) : 5;
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 20), 500);
      const market = ["000", "001", "101"].includes(String(req.query.market))
        ? String(req.query.market)
        : "000";

      const { rows: ranked, covered } = await flowRank(subject, span, limit * 3);
      const snap = await getMarketSnapshot(client);
      const index = await getStockIndex(client).catch(() => new Map());
      const want = market === "001" ? "kospi" : market === "101" ? "kosdaq" : null;

      const rows: Record<string, unknown>[] = [];
      for (const r of ranked) {
        if (rows.length >= limit) break;
        /* 순매도는 「순매수 상위」가 아니다 */
        if (r.net <= 0) continue;
        const s = snap.byCode.get(r.code);
        if (!s) continue;
        if (want && s.market !== want) continue;
        const e = index.get(r.code);
        const ex = extras({ cur_prc: String(s.price), now_trde_qty: "0", stk_cd: r.code }, e);
        rows.push({
          code: r.code,
          name: s.name,
          rank: rows.length + 1,
          cur_prc: s.price,
          flu_rt: s.changeRate,
          ...ex,
          /* 백만원 → 억. 원장이 키움과 같은 단위(백만원)로 쌓인다 */
          netEok: Math.round(r.net / 100),
          /* 실제로 더한 날 수 — 요청한 기간보다 적을 수 있다 */
          spanDays: r.days,
        });
      }

      res.json({
        spec: {
          key: `flow-${subject}`,
          label: `${SUBJECT_LABEL[subject]} 순매수 상위`,
          columns: [
            { key: "rank", label: "순위", type: "num" },
            { key: "cur_prc", label: "현재가", type: "num" },
            { key: "flu_rt", label: "등락률", type: "num" },
            { key: "netEok", label: `${span}일 순매수(억)`, type: "num" },
          ],
          exchange: false,
          /*
           * 기간을 **명세가 들고 있는다** — 화면이 이걸 읽어 단추를 그리므로
           * 여기만 고치면 화면이 따라온다. 곳마다 목록을 적으면 갈라진다.
           */
          choices: [
            {
              param: "span",
              label: "기간",
              def: "5",
              options: SPAN_OPTIONS,
            },
          ],
          note:
            `전종목 일별 원장에서 세운 순위입니다 — **조회를 하지 않습니다.** ` +
            `키움 순위 조회에는 그날 하루치밖에 없어서 「며칠 동안 누가 얼마나 샀나」를 ` +
            `물을 수가 없습니다. 원장이 ${covered}일치 쌓여 있고, 종목마다 실제로 더한 ` +
            `날 수가 다를 수 있습니다(원장이 얕으면 그만큼만 더합니다).`,
        },
        market,
        exchange: "3",
        span,
        covered,
        rows: await withFlow(rows as (Record<string, unknown> & { code: string })[]),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * **조회순위 누적** (2026-09-09 밤) — 키움이 20줄만 주므로 시간을 쌓는다 (inquirySampler).
   * `win` 30·60·180 분. 등장 횟수 → 최고 순위 순. 시세분석 표의 다른 순위와 같은 모양.
   */
  router.get("/inquiry-cum", async (req, res, next) => {
    try {
      const WINS = [30, 60, 180];
      const win = WINS.includes(Number(req.query.win)) ? Number(req.query.win) : 30;
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 20), 500);
      const market = ["000", "001", "101"].includes(String(req.query.market)) ? String(req.query.market) : "000";
      const { rows: cum, samples, oldestAt } = cumulative(win);
      const index = await getStockIndex(client).catch(() => new Map());
      const snap = await getMarketSnapshot(client).catch(() => null);
      const want = market === "001" ? "코스피" : market === "101" ? "코스닥" : null;
      const drawn = cum
        .map((r, i) => {
          const ex = extras({ cur_prc: String(r.price ?? 0), now_trde_qty: "0", stk_cd: r.code }, index.get(r.code));
          if (ex.tv === null && snap) ex.tv = snap.byCode.get(r.code)?.tradeValue ?? null;
          return {
            code: r.code,
            name: r.name,
            rank: i + 1,
            cur_prc: r.price,
            flu_rt: r.rate,
            hits: r.hits,
            share: samples > 0 ? Math.round((r.hits / samples) * 100) : null,
            bestRank: r.bestRank,
            lastRank: r.lastRank,
            firstAt: new Date(r.firstAt).toISOString(),
            ...ex,
          };
        })
        .filter((x) => !want || x.mkt === want)
        .slice(0, limit);
      const st = samplerStatus();
      res.json({
        spec: {
          key: "inquiry-cum",
          label: `조회순위 누적 (${win}분)`,
          columns: [
            { key: "rank", label: "순위", type: "num" },
            { key: "cur_prc", label: "현재가", type: "price" },
            { key: "flu_rt", label: "등락률", type: "pct" },
            { key: "hits", label: "등장", type: "num" },
            { key: "share", label: "점유", type: "num" },
            { key: "bestRank", label: "최고", type: "num" },
            { key: "lastRank", label: "지금", type: "num" },
          ],
          exchange: false,
          choices: [
            {
              param: "win",
              label: "기간",
              def: "30",
              options: WINS.map((m) => ({ value: String(m), label: m >= 60 ? `${m / 60}시간` : `${m}분` })),
            },
          ],
          note:
            `1분마다 받아 둔 조회순위(1분 기준) ${samples}장을 겹친 것입니다 — 키움은 한 번에 20종목만 주므로 ` +
            `시간을 쌓아야 그 밖이 보입니다. 「등장」은 창 안에서 목록에 오른 횟수, 「점유」는 표본 대비 %, ` +
            `「최고」는 그동안의 최고 순위, 「지금」은 마지막 장의 순위(없으면 지금은 빠진 것).` +
            (oldestAt ? ` 표본 시작 ${new Date(oldestAt + 9 * 3600_000).toISOString().slice(11, 16)} KST.` : "") +
            (st.lastError ? ` ⚠️ 마지막 수집 실패: ${st.lastError}` : "") +
            (samples === 0 ? " 아직 표본이 없습니다 — 서버가 켜진 뒤 1분마다 쌓입니다." : ""),
        },
        market,
        exchange: "3",
        chosen: { win: String(win) },
        rows: await withFlow(drawn),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * **조회순위 버즈** (2026-09-09) — 줄마다 뉴스 N회 · 텔레그램 N회. `codes` 는 쉼표로,
   * 이름은 종목 목록에서 찾는다(화면이 보내는 이름을 믿지 않는다 — 검색어가 된다).
   */
  router.get("/buzz", async (req, res, next) => {
    try {
      const codes = String(req.query.codes ?? "")
        .split(",")
        .map((c) => c.trim())
        .filter((c) => /^\d{6}$/.test(c))
        .slice(0, 100);
      const index = await getStockIndex(client).catch(() => new Map());
      const stocks = codes
        .map((code) => ({ code, name: String(index.get(code)?.name ?? "").trim() }))
        .filter((s) => s.name);
      const days = clampDays(req.query.days ?? 1);
      res.json({ items: await buzzMany(stocks, days), windowMin: Math.round(days * 24 * 60), days });
    } catch (err) {
      next(err);
    }
  });

  /** 눌렀을 때 — 그 종목의 24시간 뉴스·텔레그램 목록 */
  router.get("/buzz/:code", async (req, res, next) => {
    try {
      const code = String(req.params.code);
      if (!/^\d{6}$/.test(code)) {
        res.status(400).json({ error: "종목코드가 아닙니다." });
        return;
      }
      const index = await getStockIndex(client).catch(() => new Map());
      const name = String(index.get(code)?.name ?? "").trim();
      if (!name) {
        res.status(404).json({ error: "없는 종목입니다." });
        return;
      }
      res.json(await buzzDetail(code, name, clampDays(req.query.days ?? 1)));
    } catch (err) {
      next(err);
    }
  });

  /*
   * ⚠️ **`/:key` 는 반드시 맨 아래.**
   * 무엇이든 받으므로 위에 두면 `/cumulative` 같은 이름난 경로를 **스펙 이름으로 먹는다** —
   * 실제로 그래서 「없는 조회입니다」가 나왔다. 새 경로를 더할 때도 이 위에 둘 것.
   */
  router.get("/:key", async (req, res, next) => {
    try {
      const spec = findSpec(req.params.key);
      if (!spec) {
        res.status(404).json({ error: "없는 조회입니다." });
        return;
      }

      const market = ["000", "001", "101"].includes(String(req.query.market))
        ? String(req.query.market)
        : "000";
      const exchange = spec.exchange && ["1", "2", "3"].includes(String(req.query.exchange))
        ? String(req.query.exchange)
        : "3"; // 기본 통합 — 거래대금이 하루 전체(KRX+NXT)라 순위가 맞다. 가격만 아래에서 KRX 로 덮는다

      /**
       * 몇 건까지 받을까 — 화면이 정한다(기본 100, 최대 300).
       *
       * 키움 순위는 한 번에 백 건쯤 주고 그다음은 **연속조회**다. 예전엔 첫 장만 받아
       * 백 건에서 잘렸는데, 「거래대금 150위가 궁금하다」에 답할 수가 없었다.
       */
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 20), 500);

      /**
       * **고를 수 있는 파라미터** (2026-09-01) — `spec.choices` 가 있는 조회만.
       *
       * ⚠️ 명세에 적힌 값만 받는다. 쿼리를 그대로 흘리면 화면에서 아무 코드나
       * 넣을 수 있고, 그러면 **뜻을 모르는 응답이 「투신」이라는 이름으로 그려진다.**
       * 실측으로 확정한 것만 목록에 있으므로, 목록 밖은 기본값으로 돌린다.
       */
      const chosen: Record<string, string> = {};
      for (const ch of spec.choices ?? []) {
        const want = String(req.query[ch.param] ?? "");
        chosen[ch.param] = ch.options.some((o) => o.value === want) ? want : ch.def;
      }

      /**
       * 한 거래소에서 `limit` 만큼 모은다.
       *
       * 다음 장이 없으면 그 자리에서 멈춘다 — 코스닥 소형주처럼 목록이 짧은 조회에서
       * 빈 장을 세 번 더 부를 이유가 없다.
       */
      const ask = async (stex: string) => {
        const rows: Record<string, unknown>[] = [];
        let contYn = "N";
        let nextKey = "";
        let last: Awaited<ReturnType<typeof client.request<Record<string, unknown>>>> | null = null;
        for (let page = 0; page < 6 && rows.length < limit; page += 1) {
          const res = await client.request<Record<string, unknown>>(
            `/api/dostk/${spec.uri}`,
            spec.apiId,
            /* 시장을 안 받는 조회(조회순위)에는 제 파라미터만 보낸다 — 실측한 그대로 */
            spec.noMarket
              ? { ...(spec.params ?? {}), ...chosen }
              : {
                  ...COMMON_PARAMS,
                  ...(spec.params ?? {}),
                  ...chosen,
                  mrkt_tp: spec.marketMap ? (spec.marketMap[market] ?? spec.marketMap["000"] ?? market) : market,
                  stex_tp: stex,
                },
            page === 0 ? {} : { contYn, nextKey },
          );
          last = res;
          const got = Array.isArray(res.data[spec.listKey])
            ? (res.data[spec.listKey] as Record<string, unknown>[])
            : [];
          if (got.length === 0) break;
          rows.push(...got);
          contYn = res.contYn;
          nextKey = res.nextKey;
          if (contYn !== "Y" || !nextKey) break;
        }
        /* 모은 줄을 첫 응답 모양에 담아 돌려준다 — 아래 코드가 그대로 쓴다 */
        return {
          ...(last ?? { data: {}, contYn: "N", nextKey: "" }),
          data: { ...(last?.data ?? {}), [spec.listKey]: rows },
        };
      };

      /*
       * **KRX 를 한 번 더 받아 가격만 덮는다.**
       *
       * 순위와 거래대금은 **통합**이 맞다 — 하루 거래는 NXT 프리·KRX 정규·NXT 애프터
       * 셋의 합이고, 통합의 거래대금이 정확히 그 합이다(2026-08-24 실측).
       * KRX 만 보면 삼성전자 137,023억이 84,561억으로 줄어 순위 자체가 틀어진다.
       *
       * 그런데 **가격은 통합이 NXT 최종가**를 준다. 종목 상세는 KRX 라 목록과 상세가 갈린다.
       * 그래서 KRX 를 한 번 더 받아 **현재가·등락률만** 그걸로 바꾼다.
       *
       * TR 이 한 번 더 나가지만 순위는 자주 부르는 조회가 아니고, 실패하면 통합 값을 그대로 쓴다.
       * 거래소를 직접 고른 경우에는 안 부른다 — 그 거래소를 보겠다는 뜻이다.
       *
       * ## ⚠️ 09시 전에는 KRX 를 아예 안 본다 (2026-08-25)
       *
       * 장전(07:30~08:30)의 KRX 는 **시간외종가**다 — 전일 종가로만 체결되므로 등락률이
       * 구조적으로 0 이고 거래대금도 몇십억뿐이다. 그런데 그걸 「가격 기준」으로 삼아
       * 덮고 있었다. 08:32 에 재 보니 통합 상위 100줄 중 **9줄**(삼성전자·SK하이닉스·
       * 현대차·삼성전기·신풍제약·NAVER·심텍·한화에어로스페이스·삼천당제약)이 장전
       * KRX 목록에 걸려 **등락률이 0.00% 로 죽었다.** 나머지 91줄은 KRX 목록에 없어
       * 통합(=오늘 NXT 프리마켓) 값을 그대로 들고 있었다 — **한 표에 두 시점**이 섞였다.
       *
       * 09시 전에 오늘 값을 말할 수 있는 건 NXT 프리마켓뿐이고, 그건 통합이 이미 준다.
       */
      const [main, krx] = await Promise.all([
        ask(exchange),
        spec.exchange && exchange === "3" && krxSessionStarted()
          ? ask("1").catch(() => null)
          : Promise.resolve(null),
      ]);
      const data = main.data;

      /** KRX 몫 — 종목코드로 맞춘다 */
      const krxOf = new Map<string, { tv: number | null; price: number | null; rate: number | null }>();
      const krxRows = krx && Array.isArray(krx.data[spec.listKey])
        ? (krx.data[spec.listKey] as Record<string, unknown>[])
        : [];
      for (const r of krxRows) {
        /*
         * **KRX 에서 실제로 안 돈 종목은 없는 셈 친다.**
         * 거래가 0 이면 등락률도 0 으로 오는데, 그 0 은 「안 움직였다」가 아니라
         * 「여기서는 안 팔렸다」는 뜻이다. 그걸 통합 값 위에 덮으면 거짓말이 된다.
         */
        const qty = toNum(r.now_trde_qty) ?? toNum(r.trde_qty) ?? 0;
        if (qty <= 0) continue;
        const prica = toNum(r.trde_prica);
        krxOf.set(bare(r.stk_cd), {
          tv: prica === null ? null : Math.round(prica / 100),
          price: toNum(r.cur_prc),
          rate: toNum(r.flu_rt),
        });
      }

      const rows = Array.isArray(data[spec.listKey]) ? (data[spec.listKey] as Record<string, unknown>[]) : [];
      /*
       * 시가총액·시장은 하루 캐싱된 종목 목록에서 붙인다.
       * 목록을 못 받아도 순위 자체는 나와야 하므로 실패하면 빈 맵으로 간다.
       */
      const index = await getStockIndex(client).catch(() => new Map());
      /*
       * 거래량도 안 주는 조회(조회순위)는 거래대금을 못 낸다 — 시황 스냅샷의 어림값
       * (거래량 × 현재가, 40초 캐시)으로 메운다. 어림값이므로 `tvEst` 그대로 참이다.
       */
      /*
       * 스냅샷은 **모든 명세가** 받는다 (2026-09-22). 예전엔 조회순위(`noMarket`)만 거래대금을 메우려고
       * 받았는데, 아래 「새 날 0.00%」 메우기가 이 값을 쓴다. 40초 캐시라 조회가 안 는다.
       */
      const snap = await getMarketSnapshot(client).catch(() => null);
      /** 어제 값으로 메운 줄 수 — 절반이 넘으면 화면에 「어제 값」이라고 알린다 */
      let filledFromSnap = 0;
      const drawn = rows.slice(0, limit).map((r) => {
          const code = bare(r.stk_cd);
          const k = krxOf.get(code);
          const mapped = mapRow(r, spec);
          /*
           * 가격만 KRX 로 덮는다. 거래대금·순위는 통합 그대로다.
           * KRX 에 그 종목이 없으면(그날 KRX 에서 안 돌았으면) 통합 값을 남긴다.
           *
           * ## 덮기 전 값을 버리지 않는다 (2026-08-25)
           *
           * 통합의 가격은 NXT 최종가다 — 저녁에 보면 애프터장에서 +2.33% 간 종목이
           * KRX 마감 +0.42% 로만 보여서 「통합인데 왜 KRX 만 나오나」가 됐다.
           * 그래서 KRX 로 덮되, **KRX 와 다르면 원래(NXT) 값을 nxtPrice·nxtRate 로**
           * 같이 내린다. 화면이 괄호로 붙인다 — 해외 관심종목의 시간외 괄호와 같은 문법.
           */
          let nxtPrice: number | null = null;
          let nxtRate: number | null = null;
          if (k?.price != null) {
            const orig = toNum(mapped.cur_prc);
            /*
             * ⚠️ 「KRX 와 다를 때만」 병기했더니 깜빡였다 (2026-08-27) — NXT 체결가가
             * KRX 종가와 같아지는 순간 괄호가 사라지고 한 틱 벌어지면 다시 나타나서
             * 「나왔다 안 나왔다」가 됐다. 항상 내리고, 보여줄 시간대는 화면이 정한다.
             */
            if (orig !== null) {
              nxtPrice = Math.abs(orig);
              nxtRate = toNum(mapped.flu_rt);
            }
            // 부호는 여기서도 뗀다 — KRX 응답도 하락이면 음수로 온다
            mapped.cur_prc = Math.abs(k.price);
          }
          if (k?.rate != null) mapped.flu_rt = k.rate;
          /*
           * 등락률을 안 주는 조회(호가잔량 급증 ka10021 — 실측 2026-09-10)는 전일대비로 낸다:
           * 전일 종가 = 현재가 − 전일대비. 화면이 색을 칠하고 실시간을 덧씌우는 칸이라 비워 두면 안 된다.
           */
          if (toNum(mapped.flu_rt) === null) {
            const cur = toNum(mapped.cur_prc);
            const pre = toNum(r.pred_pre);
            if (cur !== null && pre !== null && Math.abs(cur) - pre !== 0) {
              mapped.flu_rt = Math.round((pre / (Math.abs(cur) - pre)) * 10000) / 100;
            }
          }
          /*
           * **새 날 아침엔 등락률이 0 으로 온다** (2026-09-22 — 벤티지: "실시간 조회순위가 들어가니까
           * 전부 다 다시 0.00 이렇게 뜨네 … 모든 곳에 전날 데이터 들고 있어야 내가 다른 데 데이터도
           * 계속 볼수 있겠지?").
           *
           * 키움 TR 은 장이 시작되기 전에는 **현재가 = 전일 종가 · 등락률 0** 으로 답한다. 거래대금
           * 상위 같은 탭은 「어제 마지막 응답 파일」(`rankLast`)이 살려 주는데, 그 보정은 `looksReset`
           * (거래대금 0 **이면서** 등락률 0)에 걸려야 하고 `noMarket` 명세는 아예 빠져 있었다.
           * 조회순위는 거래대금을 스냅샷으로 메우니 0 이 아니라 **구조적으로 그 판정에 안 걸린다.**
           *
           * 그래서 줄 단위로 메운다 — **등락률이 0 인데 스냅샷은 0 이 아니면** 스냅샷의 어제 종가·
           * 등락률로 바꾼다. 스냅샷은 다음 개장까지 어제 값을 들고 있고(`marketSnapshot` 의 `traded`),
           * 장중에는 같은 값이라 바뀌는 것이 없다. 진짜 보합(0.00%)은 스냅샷도 0 이라 안 건드린다.
           */
          if (snap) {
            const s = snap.byCode.get(code);
            /* **정확히 0 일 때만** — 위에서 전일대비로 되짚은 값(`null` 이던 것)은 그대로 둔다 */
            if (s && s.changeRate !== 0 && toNum(mapped.flu_rt) === 0) {
              mapped.cur_prc = Math.abs(s.price);
              mapped.flu_rt = s.changeRate;
              filledFromSnap += 1;
            }
          }
          /*
           * `extras` 는 `cur_prc` 로 시가총액을 낸다 — 이름을 바꿔 읽는 조회(`src`)는
           * 원 응답에 `cur_prc` 가 없으므로 우리 이름으로 맞춘 값을 같이 넘긴다.
           */
          const ex = extras({ ...r, cur_prc: mapped.cur_prc ?? r.cur_prc }, index.get(code));
          if (ex.tv === null && snap) ex.tv = snap.byCode.get(code)?.tradeValue ?? null;
          return {
            ...mapped,
            code,
            ...ex,
            tvKrx: k?.tv ?? null,
            nxtPrice,
            nxtRate,
          };
        })
        /* 시장을 안 받는 조회는 여기서 시장을 거른다 — 종목 목록이 말하는 시장으로 */
        .filter((x) =>
          !spec.noMarket || market === "000"
            ? true
            : x.mkt === (market === "001" ? "코스피" : "코스닥"),
        );
      /*
       * 조회순위 — **새로 진입**을 찍는다. 시장을 거르기 전의 스무 종목이 기준이다
       * (코스닥만 보다가 전체로 돌아왔을 때 코스피 종목이 전부 「새로」면 안 된다).
       */
      if (spec.key === "inquiry-rank") {
        const entered = markEntered(
          chosen.qry_tp ?? "1",
          rows.slice(0, limit).map((r) => bare(r.stk_cd)),
        );
        for (const x of drawn) (x as Record<string, unknown>).enteredAt = entered.get(x.code) ?? null;
        /* 1분 기준 응답은 누적 표본으로도 쓴다 — 사람이 보고 있으면 그만큼 촘촘해진다 */
        if ((chosen.qry_tp ?? "1") === "1") {
          noteLiveSample(
            rows.slice(0, limit).map((r, i) => ({
              code: bare(r.stk_cd),
              name: String(r.stk_nm ?? "").trim(),
              rank: toNum(r.bigd_rank) ?? i + 1,
              price: toNum(r.past_curr_prc) === null ? null : Math.abs(toNum(r.past_curr_prc) as number),
              rate: toNum(r.base_comp_chgr),
            })),
          );
        }
      }
      /* 빈 껍데기면 어제 마감 값으로 — 값이 있으면 그걸 다음을 위해 남긴다 */
      const lastKey = `${spec.key}.${market}.${exchange}.${limit}.${Object.entries(chosen).map(([k, v]) => `${k}=${v}`).join(",")}`;
      let outRows: Record<string, unknown>[] = await withFlow(drawn);
      let staleNote = "";
      if (!spec.noMarket && looksReset(outRows as { tv: number | null; flu_rt?: unknown }[])) {
        const last = await loadLast(lastKey);
        if (last && last.rows.length > 0) {
          outRows = last.rows as Record<string, unknown>[];
          staleNote = `⚠️ 키움이 새 날 값을 아직 안 줍니다(거래대금·등락률 0). ${kstStamp(last.at)} 기준 마지막 값을 보여 줍니다 — 08시 프리마켓이 열리면 새 값으로 바뀝니다. `;
        }
      } else if (!spec.noMarket && outRows.length >= 5) {
        void saveLast(lastKey, outRows);
      }
      /*
       * **당일 봉** (2026-09-22 — 벤티지: "등락률 옆에 봉 차트 보여줄 수 있어? 한눈에 당일 흐름 봉으로
       * 알수 있게끔"). 등락률 숫자만으로는 **어떻게 그 숫자가 됐는지**가 안 보인다 — 위로 갔다 내려온
       * +3% 와 쭉 오른 +3% 는 완전히 다른 종목이다.
       *
       * 순위 TR 은 시·고·저를 안 준다(ka10032 실측: 칸 13개, 현재가·전일대비·등락률·거래량·거래대금뿐).
       * `ka10095` 가 준다 — 한 번에 여러 종목(`|`)이라 100줄이면 조회 두 번이다.
       * **화면이 `candle=1` 로 물을 때만** 부른다 — 칸을 꺼 두면 조회가 안 나간다.
       */
      if (String(req.query.candle ?? "") === "1" && outRows.length > 0) {
        const cd = await candles(client, outRows.map((r) => String(r.code ?? ""))).catch(() => null);
        if (cd) for (const r of outRows) r.cd = cd.get(String(r.code ?? "")) ?? null;
      }
      /*
       * 줄 단위로 메웠으면 그것도 「어제 값」이다 — 절반이 넘을 때만 알린다 (2026-09-22).
       * 파일 되살리기(`rankLast`)가 이미 말을 걸었으면 덧붙이지 않는다.
       */
      if (!staleNote && outRows.length > 0 && filledFromSnap > outRows.length / 2) {
        staleNote = `⚠️ 키움이 아직 새 날 등락률을 안 줍니다(전부 0.00%). 현재가·등락률은 **어제 마감 값**입니다 — 09시 개장하면 오늘 값으로 바뀝니다. `;
      }
      res.json({
        spec: {
          key: spec.key,
          label: spec.label,
          columns: spec.columns,
          exchange: Boolean(spec.exchange),
          /* 화면이 버튼을 그리려면 무엇을 고를 수 있는지 알아야 한다 */
          choices: spec.choices ?? [],
          note: staleNote + (spec.note ?? ""),
        },
        market,
        exchange,
        /* 지금 무엇으로 골라 부른 것인가 — 화면이 눌린 버튼을 표시한다 */
        chosen,
        stale: staleNote ? true : false,
        rows: outRows,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
