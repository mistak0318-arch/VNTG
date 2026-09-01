import type { KiwoomClient } from "./kiwoomClient.js";
import { getCommonStockCodes } from "./stockListCache.js";
import {
  KIND_LABEL,
  LEDGER_KINDS,
  autoTrim,
  keepDays,
  loadLedger,
  mergeRows,
  saveLedger,
  type DailyLedger,
  type FlowRow,
  type LedgerKind,
  type LoanRow,
  type ProgRow,
  type RatioRow,
  type ShortRow,
  putCollectRun,
} from "./dailyStore.js";
import { alCode } from "./alCode.js";

/**
 * **전종목 일별 수집** (2026-09-01).
 *
 * 벤티지: "지금 로직상에 수집하는 모든것 전종목 기준으로 데이터 다 받아."
 *
 * ## 왜 전종목이 되나 — 거래원은 왜 안 되나
 *
 * 여기 있는 것들은 **하루 한 번**이면 된다. 종목당 5콜, 키움 초당 5회니까
 * 2,444종목이면 한 바퀴 **약 41분**이다. 마감 뒤에 돌리면 끝난다.
 *
 * 거래원(`ka10040`)만 다르다 — 그건 **당일 누적**만 줘서 시간대별 흐름을 만들려면
 * 하루에 수십 번 찍어야 한다. 전종목 × 수십 번은 한도의 열여섯 배라 불가능하다.
 * 그래서 그쪽은 `brokerAuto` 가 **관심종목 + 오늘 초록**만 따라간다.
 *
 * ## 무엇을 받나
 *
 *   ka10060  투자자별 순매수 **열세 주체** (100일치/콜)
 *   ka10014  공매도 (기간 지정)
 *   ka20068  대차잔고 (기간 지정)
 *   ka10008  외국인 지분율 ⚠️ **최근 것만** — 과거는 못 받는다. 오늘부터 쌓인다
 *   ka90013  프로그램 순매수
 *
 * 일봉(`ka10081`)은 `dailyCloses` 가 이미 전종목을 돌고 있어서 여기서 또 받지
 * 않는다 — **같은 것을 두 번 받으면 한 바퀴가 두 배가 된다.**
 *
 * ## 이어 붙인다
 *
 * 받은 것으로 갈아치우지 않는다. 옛 줄을 남기고 겹치는 날만 덮으면 **하루하루
 * 뒤로 자란다** — 그게 「2년치·5년치」가 생기는 유일한 방법이다. 응답이 주는
 * 100일에서 멈추면 아무리 기다려도 100일이다.
 *
 * ## 중간에 끊겨도 이어서
 *
 * 41분짜리 작업이다. 그 사이 배포·재시작이 있으면 통째로 날아가면 안 된다.
 * 종목마다 저장하고(파일이 종목별이라 그게 자연스럽다) **오늘 이미 받은 종목은
 * 건너뛴다.**
 */

const CHART = "/api/dostk/chart";
const SHSA = "/api/dostk/shsa";
const SLB = "/api/dostk/slb";
const FRGNISTT = "/api/dostk/frgnistt";
const MRKCOND = "/api/dostk/mrkcond";

function n(v: unknown): number | null {
  const t = String(v ?? "").replace(/[+,\s]/g, "");
  if (t === "") return null;
  const x = Number(t);
  return Number.isFinite(x) ? x : null;
}

/** YYYYMMDD 로 — 세 TR 이 날짜 칸 이름이 제각각이다 */
function ymd8(v: unknown): string {
  const t = String(v ?? "").replace(/[^0-9]/g, "");
  return /^\d{8}$/.test(t) ? t : "";
}

function todayYmd(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * **장 마감(15:40 KST) 이 지났나** — 오늘 줄을 담을지 정한다.
 *
 * 장중에 받으면 그날 값이 **미집계 0** 으로 온다. 실측: 삼성전자 대차잔고가
 * 20260831 까지 8,830만주인데 20260901(장중)만 0 이었다. 그걸 그대로 담으면
 * 「아직 안 나왔다」가 **「0 이다」로 굳는다** — 이 도구에서 계속 피해 온 실수다.
 *
 * 그래서 마감 전에는 **오늘 줄을 버린다.** 어제까지는 확정값이라 그대로 담는다.
 */
function closedForToday(at = Date.now()): boolean {
  const d = new Date(at);
  const kst = new Date(d.getTime() + (9 * 60 + d.getTimezoneOffset()) * 60_000);
  return kst.getHours() * 60 + kst.getMinutes() >= 15 * 60 + 40;
}

function daysAgoYmd(days: number): string {
  return new Date(Date.now() + 9 * 3600_000 - days * 86_400_000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");
}

/* ------------------------------------------------------------------ */
/* 종류별 받아오기 — 하나가 실패해도 나머지는 받는다                     */
/* ------------------------------------------------------------------ */

/**
 * 투자자별 순매수 — **열세 주체를 다 담는다.**
 *
 * 예전 표본은 외국인·기관과 「주포 셋의 합」만 남겼다. 그래서 「보험이 사는 종목이
 * 좋은가」에 아예 답할 수가 없었다 — 같은 응답에 들어 있는데 골라서 버린 것이다.
 */
async function fetchFlow(client: KiwoomClient, code: string): Promise<FlowRow[]> {
  const res = await client.request<Record<string, unknown>>(CHART, "ka10060", {
    stk_cd: code,
    dt: todayYmd(),
    amt_qty_tp: "1", // 1 금액 · 2 수량
    trde_tp: "0",
    unit_tp: "1000", // 백만원
  });
  const rows = (res.data?.stk_invsr_orgn_chart ?? []) as Record<string, unknown>[];
  return rows
    .map((r) => ({
      d: ymd8(r.dt),
      ind: n(r.ind_invsr),
      fgn: n(r.frgnr_invsr),
      org: n(r.orgn),
      fin: n(r.fnnc_invt),
      ins: n(r.insrnc),
      trust: n(r.invtrt),
      bank: n(r.bank),
      pen: n(r.penfnd_etc),
      samo: n(r.samo_fund),
      natn: n(r.natn),
      corp: n(r.etc_corp),
      natfor: n(r.natfor),
      etcFin: n(r.etc_fnnc),
    }))
    .filter((r) => r.d !== "");
}

/** 공매도 — 통합(`_AL`). KRX 단독은 매매비중 분모가 작아 비중이 부푼다 */
async function fetchShort(client: KiwoomClient, code: string, back: number): Promise<ShortRow[]> {
  const res = await client.request<Record<string, unknown>>(SHSA, "ka10014", {
    stk_cd: alCode(code),
    tm_tp: "1",
    strt_dt: daysAgoYmd(back),
    end_dt: todayYmd(),
  });
  const rows = (res.data?.shrts_trnsn ?? []) as Record<string, unknown>[];
  return rows
    /*
     * `shrts_qty` 는 그날 공매도 **수량**(잔고가 아니다), `trde_wght` 가 매매비중(%)이다.
     * 비중 필드를 짐작으로 `shrts_trde_prica_rt` 라 적었었다 — 그런 칸은 없다.
     */
    .map((r) => ({ d: ymd8(r.dt), qty: n(r.shrts_qty), ratio: n(r.trde_wght) }))
    .filter((r) => r.d !== "");
}

async function fetchLoan(client: KiwoomClient, code: string, back: number): Promise<LoanRow[]> {
  const res = await client.request<Record<string, unknown>>(SLB, "ka20068", {
    strt_dt: daysAgoYmd(back),
    end_dt: todayYmd(),
    all_tp: "0",
    stk_cd: code,
  });
  const rows = (res.data?.dbrt_trde_trnsn ?? []) as Record<string, unknown>[];
  return rows.map((r) => ({ d: ymd8(r.dt), rmnd: n(r.rmnd) })).filter((r) => r.d !== "");
}

/**
 * 외국인 지분율.
 *
 * ⚠️ **최근 것만 준다.** 과거를 받을 방법이 없어서 표본 커버리지가 3% 였다 —
 * 검증이 막힌 기준 셋 중 하나다. 매일 한 줄씩 찍어 두면 **시간이 해결한다.**
 */
async function fetchRatio(client: KiwoomClient, code: string): Promise<RatioRow[]> {
  const res = await client.request<Record<string, unknown>>(FRGNISTT, "ka10008", { stk_cd: code });
  const rows = (res.data?.stk_frgnr ?? []) as Record<string, unknown>[];
  return rows
    .map((r) => ({ d: ymd8(r.dt), ratio: n(r.wght) }))
    .filter((r) => r.d !== "" && r.ratio !== null);
}

/** 프로그램 순매수 */
async function fetchProg(client: KiwoomClient, code: string): Promise<ProgRow[]> {
  /*
   * ⚠️ URI·응답키·필드를 **이미 도는 코드에서 가져왔다**(`signalLight` 의 programFlow).
   * 처음엔 셋 다 짐작으로 적었는데 — TR 이름만 맞고 나머지가 다 틀렸다. 그렇게
   * 두면 조회는 나가고 값은 안 담긴다. **아무도 눈치 못 채는 실패**다.
   *
   * 통합(`_AL`) — 프로그램도 NXT 몫이 있다.
   */
  const res = await client.request<Record<string, unknown>>(MRKCOND, "ka90013", {
    stk_cd: alCode(code),
    date: todayYmd(),
    amt_qty_tp: "1",
  });
  const rows = (res.data?.stk_daly_prm_trde_trnsn ?? []) as Record<string, unknown>[];
  return rows
    .map((r) => {
      const buy = n(r.prm_buy_amt);
      const sell = n(r.prm_sell_amt);
      return {
        d: ymd8(r.dt),
        /* 순매수 = 매수 − 매도. 한쪽이라도 없으면 못 낸다 — 0 으로 만들지 않는다 */
        net: buy === null || sell === null ? null : buy - sell,
      };
    })
    .filter((r) => r.d !== "");
}

/* ------------------------------------------------------------------ */
/* 한 바퀴                                                              */
/* ------------------------------------------------------------------ */

export interface CollectProgress {
  running: boolean;
  done: number;
  total: number;
  /** 종류별로 몇 줄이나 새로 담았나 */
  added: Record<string, number>;
  fails: number;
  startedAt: string;
  finishedAt?: string;
  /** 지금 어느 종목을 받고 있나 — 멈춘 것처럼 보일 때 확인용 */
  at?: string;
}

let progress: CollectProgress = {
  running: false,
  done: 0,
  total: 0,
  added: {},
  fails: 0,
  startedAt: "",
};
let running: Promise<CollectProgress> | null = null;

export function collectProgress(): CollectProgress {
  return { ...progress, added: { ...progress.added } };
}

/**
 * 전종목 한 바퀴.
 *
 * @param kinds 받을 종류. 안 주면 일봉을 뺀 다섯 (일봉은 `dailyCloses` 몫이다)
 * @param back 공매도·대차를 며칠 뒤까지 달라 할까. 첫 수집은 넉넉히, 뒤에는 짧게
 */
export function startCollectDaily(
  client: KiwoomClient,
  kinds: LedgerKind[] = ["flow", "short", "loan", "fgnRatio", "prog"],
  back = 120,
  /** 몇 종목만 시험 삼아 — 41분짜리를 돌리기 전에 값이 제대로 담기는지 본다 */
  only?: string[],
  /** 사람이 눌러서 돌린 것인가 — 이력에 적어 두면 「자동이 실패해서 손으로 돌렸다」가 보인다 */
  manual = false,
): Promise<CollectProgress> {
  if (running) return running;

  running = (async () => {
    const codes = only?.length
      ? only
      : [...(await getCommonStockCodes(client).catch(() => new Set<string>()))];
    const keep = autoTrim() ? keepDays() : 0;
    const today = todayYmd();

    progress = {
      running: true,
      done: 0,
      total: codes.length,
      added: {},
      fails: 0,
      startedAt: new Date().toISOString(),
    };

    /*
     * **시작할 때 적는다** (2026-09-01). 끝나고 적으면 죽은 회차가 영영 기록에
     * 안 남는다 — 41분짜리라 그 사이 재시작이 잦다. `running` 인 채로 남아 있으면
     * 그게 곧 「그날 실패했다」는 뜻이고, 서버가 뜰 때 `closeStaleRuns` 가 닫는다.
     */
    const day = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    await putCollectRun({
      day,
      startedAt: progress.startedAt,
      status: "running",
      done: 0,
      total: codes.length,
      fails: 0,
      added: {},
      manual: only !== undefined && only.length > 0 ? undefined : manual,
    }).catch(() => undefined);

    for (const code of codes) {
      progress.done += 1;
      progress.at = code;
      const led: DailyLedger = await loadLedger(code);
      led.fetchedAt ??= {};

      for (const kind of kinds) {
        /*
         * **오늘 이미 받았으면 건너뛴다.** 41분짜리 작업이라 그 사이 재시작이
         * 있으면 처음부터 다시 도는데, 그러면 영영 못 끝낸다.
         */
        if (String(led.fetchedAt[kind] ?? "").slice(0, 10) === new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)) {
          continue;
        }
        try {
          let got: { d: string }[] = [];
          if (kind === "flow") got = await fetchFlow(client, code);
          else if (kind === "short") got = await fetchShort(client, code, back);
          else if (kind === "loan") got = await fetchLoan(client, code, back);
          else if (kind === "fgnRatio") got = await fetchRatio(client, code);
          else if (kind === "prog") got = await fetchProg(client, code);
          else continue;

          /*
           * 마감 전이면 **오늘 줄을 버린다.** 미집계 0 을 값으로 굳히지 않는다.
           * 이어 붙이는 구조라 마감 뒤 바퀴에서 확정값으로 들어온다.
           */
          if (!closedForToday()) got = got.filter((r) => r.d !== todayYmd());

          if (got.length > 0) {
            const before = (led[kind] as { d: string }[] | undefined)?.length ?? 0;
            /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
            (led as any)[kind] = mergeRows((led[kind] as any) ?? [], got as any, keep);
            const after = (led[kind] as { d: string }[]).length;
            progress.added[kind] = (progress.added[kind] ?? 0) + Math.max(0, after - before);
          }
          led.fetchedAt[kind] = new Date().toISOString();
        } catch {
          progress.fails += 1;
        }
        /*
         * ## 220 → 120ms (2026-09-01 실측)
         *
         * 220ms 는 「키움 초당 5회」를 그대로 옮긴 값인데, **이 수집은 다섯 가지
         * 다른 TR 을 번갈아 부른다.** 제한은 TR당이므로 각 TR 은 1.1초에 한 번,
         * 즉 **한도의 18%** 만 쓰고 있었다.
         *
         * 120ms 면 TR당 0.6초에 한 번(34%)이라 여전히 여유가 있고, 전종목 한
         * 바퀴가 **48분 → 26분**이 된다.
         *
         * ⚠️ 429 가 나면 `KiwoomClient` 가 백오프한다 — 안전망은 그쪽이다.
         */
        await new Promise((r) => setTimeout(r, 120));
      }

      led.updatedAt = new Date().toISOString();
      await saveLedger(led).catch(() => undefined);
    }

    progress.running = false;
    progress.finishedAt = new Date().toISOString();
    progress.at = undefined;
    void today;

    await putCollectRun({
      day,
      startedAt: progress.startedAt,
      finishedAt: progress.finishedAt,
      status: "done",
      done: progress.done,
      total: progress.total,
      fails: progress.fails,
      added: { ...progress.added },
      manual,
    }).catch(() => undefined);

    return progress;
  })().finally(() => {
    running = null;
  });

  return running;
}

/** 화면·기록용 */
export { KIND_LABEL, LEDGER_KINDS };
