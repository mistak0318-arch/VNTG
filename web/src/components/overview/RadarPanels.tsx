import { useEffect, useState } from "react";
import { api, type GlobalQuote, type IndexCard, type MarketFlow, type RadarData, type UsMajorResult } from "../../api";
import { useTabActive } from "../../tabActive";

/** 선물 투자자별 하루치 — `api.futuresFlow` 가 `{days:[…]}` 로 준다(억원) */
interface FuturesFlowDay {
  date: string;
  individual: number;
  foreign: number;
  institution: number;
}

/*
 * 선물 수급을 **머리띠와 선물 카드가 같이** 본다. 각자 부르면 같은 값을 두 번 받으므로
 * 모듈 하나에 마지막 값을 들고, 60초 안에 들어온 요청은 그걸 그대로 쓴다.
 * (우리 서버 캐시를 두들기는 것이라 비싸진 않지만, 같은 화면이 같은 값을 두 번 받을 이유가 없다)
 */
let ffCache: { at: number; days: FuturesFlowDay[] } | null = null;
let ffInflight: Promise<FuturesFlowDay[]> | null = null;

async function loadFuturesFlow(): Promise<FuturesFlowDay[]> {
  if (ffCache && Date.now() - ffCache.at < 60_000) return ffCache.days;
  if (ffInflight) return ffInflight;
  ffInflight = api
    .futuresFlow(1)
    .then((d) => {
      const days = d.days ?? [];
      ffCache = { at: Date.now(), days };
      return days;
    })
    .catch(() => (ffCache?.days ?? []))
    .finally(() => {
      ffInflight = null;
    });
  return ffInflight;
}

/** 오늘(마지막) 선물 투자자 수급 한 줄. 숨은 탭에서는 안 돈다 */
function useFuturesFlowToday(): FuturesFlowDay | null {
  /* `at(-1)` 은 이 프로젝트의 lib 설정에 없다 — 길이로 꺼낸다 */
  const first = ffCache && ffCache.days.length > 0 ? ffCache.days[ffCache.days.length - 1] : null;
  const [day, setDay] = useState<FuturesFlowDay | null>(first);
  const tabActive = useTabActive();
  useEffect(() => {
    if (!tabActive) return;
    let alive = true;
    const load = () => {
      void loadFuturesFlow().then((days) => {
        if (alive) setDay(days.length > 0 ? days[days.length - 1] : null);
      });
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [tabActive]);
  return day;
}

/**
 * **시장상황 레이더** (2026-11-24 — 벤티지: "선물 콜옵션/풋옵션 매매 현황, 코스피 200 선물 수급
 * 현황, 코스피, 코스닥 수급 현황, 나스닥 100 선물 현황, 유가지수, 10년물 20년물 금리현황,
 * 이런식으로 시장상황 레이더 하나 만들고").
 *
 * ## 조회를 하나도 안 늘렸다
 *
 * 여섯 갈래 중 **넷은 대시보드가 이미 받고 있던 값**이다 — 수급은 `flow`, 코스피200 선물은
 * `indices` 안의 `futures`, 나스닥100 선물은 `global`, 유가·미국 10/30년은 `usMajor`.
 * 레이더는 그 섹션 훅을 **그대로 넘겨받아** 쓴다. 새로 받는 건 옵션 전광판과 미국 20년물뿐이고
 * 그 둘은 서버의 `radar` 섹션 하나에 묶여 분당 한 번이다.
 *
 * ## 읽는 차례
 *
 * 국내 현물 수급 → 선물 → 옵션 → 미국 선물 → 금리 → 유가.
 * **우리 장에서 시작해 바깥으로 나간다.** 아침에 거꾸로 읽고 싶으면 카드 순서를 바꾸면 된다
 * (설정 > 화면 > 시황 카드 순서 — 레이더도 탭별로 따로 저장된다).
 *
 * ## 숫자마다 **무엇 대비인지** 적는다
 *
 * 2026-11-20 에 한 화면이 자를 두 개 쓰는 바람에 같은 가격이 두 등락률로 보였다. 레이더는
 * 출처도 기준일도 제각각이라 그 위험이 더 크다 — 그래서 칸마다 단위(억원·계약·%)와,
 * 오늘 값이 아니면 **날짜**를 붙인다.
 */

/* ── 공통 ──────────────────────────────────────────────────────────────── */

function cls(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "";
  return v > 0 ? "positive" : v < 0 ? "negative" : "";
}

/** 억원 — 부호를 붙이고 천 단위를 끊는다 */
function eok(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  return `${v > 0 ? "+" : ""}${Math.round(v).toLocaleString("ko-KR")}`;
}

function n0(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  return Math.round(v).toLocaleString("ko-KR");
}

function pct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

/** MM/DD — 오늘이 아닐 때만 쓴다 */
function md(date: string | null | undefined): string {
  if (!date || date.length < 10) return "";
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

/** 못 받은 칸은 **까닭을 적는다** — 빈 칸은 「0」과 구별이 안 된다 */
function Empty({ why }: { why?: string }) {
  return <div className="rdr-empty pt-n">{why ? `못 받았습니다 — ${why}` : "아직 값이 없습니다"}</div>;
}

/** 세 투자자 한 줄 */
function FlowRow({ label, f, unit }: { label: string; f: { individual: number; foreign: number; institution: number } | null; unit: string }) {
  if (!f) return null;
  return (
    <div className="rdr-flow">
      <em className="rdr-flow-k">{label}</em>
      <span className={`rdr-flow-v ${cls(f.foreign)}`}>
        <i>외국인</i>
        <b>{eok(f.foreign)}</b>
      </span>
      <span className={`rdr-flow-v ${cls(f.institution)}`}>
        <i>기관</i>
        <b>{eok(f.institution)}</b>
      </span>
      <span className={`rdr-flow-v ${cls(f.individual)}`}>
        <i>개인</i>
        <b>{eok(f.individual)}</b>
      </span>
      <em className="rdr-unit pt-n">{unit}</em>
    </div>
  );
}

/* ── ⓪ 지금 시장 (머리띠) ────────────────────────────────────────────────── */

/**
 * **「아 지금 시장 색깔이 이거구나」** (2026-11-24 — 벤티지: "여기 눈에 좀 들어오게 하자.
 * 이걸로 종가배팅할지 아니면 장중 분위기 재는거 볼지 하려고 하는 거거든").
 *
 * ## 새 점수가 아니다 — **아래 카드가 이미 말하는 것을 맨 위로 끌어올린 것**이다
 *
 * 점수를 또 만들면 검증 안 된 자가 하나 더 생긴다(신호등이 왜 동결 중인지 생각하면 된다).
 * 그래서 여기 쓰는 문턱은 **시장 관행에 이미 있는 것뿐**이고, 그나마도 아래 카드에 이미
 * 글로 적혀 있는 것들이다:
 *
 *   · 베이시스 음수 = 백워데이션 (선물 카드가 적고 있다)
 *   · VKOSPI 보통 15~20, 30 위면 공포 (옵션 카드가 적고 있다)
 *   · 외국인·기관이 **같은 쪽**이면 쌍끌이 (수급 카드의 두 숫자)
 *
 * 합산도 가중치도 없다. 네 칸이 **각자 제 말을 한다** — 네 칸이 다 같은 쪽을 가리키는
 * 날이 드물고, 갈릴 때 어디가 갈렸는지가 보이는 게 요점이다.
 *
 * ## 네 칸을 고른 까닭
 *
 * 종가배팅과 장중 분위기, 둘 다에 실제로 쓰이는 것만 올렸다 —
 * **오늘 현물 수급**(누가 담고 있나) · **선물**(외국인 선물과 베이시스는 종가 프로그램의
 * 앞잡이다) · **변동성**(겁먹은 장에서는 종가배팅 자체를 줄여야 한다) · **밤**(미국 선물이
 * 지금 어디로 가는지는 내일 갭이다). 금리·유가는 배경이라 머리띠에 안 올렸다.
 */
export function RadarVerdict({
  flow,
  indices,
  global,
}: {
  flow: MarketFlow | null;
  indices: IndexCard[] | null;
  global: GlobalQuote[] | null;
}) {
  const fut = useFuturesFlowToday();
  const k200 = (indices ?? []).find((i) => i.futures) ?? null;
  const basis = k200?.futures?.basis ?? null;
  const vk = (global ?? []).find((g) => g.key === "vkospi") ?? null;
  const nq = (global ?? []).find((g) => g.key === "nqF") ?? null;

  type Tone = "up" | "down" | "warn" | "flat";
  interface Cell {
    k: string;
    /** 큰 글자 — 한눈에 읽히는 게 전부다 */
    v: string;
    tone: Tone;
    /** 근거 숫자 하나. 판정만 있고 근거가 없으면 믿을 수가 없다 */
    why: string;
  }

  const cells: Cell[] = [];

  /* ① 오늘 현물 수급 — 코스피 기준(코스닥은 아래 카드에서) */
  const kf = flow?.kospi ?? null;
  if (kf) {
    const f = kf.foreign;
    const i = kf.institution;
    const both = f > 0 && i > 0;
    const neither = f < 0 && i < 0;
    cells.push({
      k: flow?.asOf ? `수급 ${md(flow.asOf)}` : "오늘 수급",
      v: both ? "쌍끌이 매수" : neither ? "쌍끌이 매도" : f > 0 ? "외국인만 매수" : i > 0 ? "기관만 매수" : "엇갈림",
      tone: both ? "up" : neither ? "down" : "flat",
      why: `외 ${eok(f)} · 기 ${eok(i)} 억`,
    });
  }

  /* ② 선물 — 외국인 방향이 큰 글자, 베이시스가 단서 */
  if (fut || basis !== null) {
    const ff = fut?.foreign ?? null;
    cells.push({
      k: "선물",
      v: ff === null ? "수급 없음" : ff > 0 ? "외국인 매수" : ff < 0 ? "외국인 매도" : "보합",
      tone: ff === null ? "flat" : ff > 0 ? "up" : ff < 0 ? "down" : "flat",
      why: basis === null ? (ff === null ? "-" : `${eok(ff)} 억`) : `${basis < 0 ? "백워데이션" : "콘탱고"} ${basis.toFixed(2)}${ff === null ? "" : ` · ${eok(ff)} 억`}`,
    });
  }

  /* ③ 변동성 — 관행 문턱(15~20 보통 · 30 위 공포)만 쓴다 */
  if (vk?.price != null) {
    const p = vk.price;
    cells.push({
      k: "변동성",
      v: p >= 30 ? "공포" : p >= 20 ? "경계" : p >= 15 ? "보통" : "안정",
      tone: p >= 30 ? "warn" : p >= 20 ? "warn" : "flat",
      why: `VKOSPI ${p.toFixed(1)}`,
    });
  }

  /* ④ 밤 — 미국 지수선물이 지금 어디로 */
  if (nq?.changeRate != null) {
    const r = nq.changeRate;
    cells.push({
      k: "밤(미국선물)",
      v: r >= 0.5 ? "강세" : r <= -0.5 ? "약세" : "보합",
      tone: r >= 0.5 ? "up" : r <= -0.5 ? "down" : "flat",
      why: `나스닥100 ${pct(r)}`,
    });
  }

  if (cells.length === 0) return null;
  return (
    <div className="rdv">
      {cells.map((c) => (
        <div className={`rdv-cell ${c.tone}`} key={c.k}>
          <em className="rdv-k">{c.k}</em>
          <b className="rdv-v">{c.v}</b>
          <span className="rdv-why">{c.why}</span>
        </div>
      ))}
    </div>
  );
}

/* ── ① 코스피·코스닥 수급 ───────────────────────────────────────────────── */

/**
 * 오늘 누가 샀나. **장 전에는 서버가 지난 장 값을 싣는다** — 그때 `asOf` 가 오므로
 * 날짜를 머리에 적는다. 안 적으면 아침에 그게 오늘로 읽힌다(이미 겪은 일이다).
 */
export function RadarKrFlow({ flow }: { flow: MarketFlow | null }) {
  if (!flow) return <Empty />;
  return (
    <div className="rdr">
      {flow.asOf && <div className="rdr-asof pt-n">{md(flow.asOf)} 장 기준 — 오늘 값이 아직 없습니다</div>}
      <FlowRow label="코스피" f={flow.kospi} unit="억원" />
      <FlowRow label="코스닥" f={flow.kosdaq} unit="억원" />
      {/*
        누적을 한 줄 붙인다 — 하루치만 보면 「오늘 외국인이 샀다」까지인데, 20일 누적이
        같이 있으면 **추세 중의 하루인지 되돌림인지**가 갈린다. 서버가 이미 보내는 값이라 공짜다.
      */}
      {(flow.windows ?? [])
        .filter((w) => w.days === 20)
        .map((w) => (
          <div key={w.days} className="rdr-sub">
            <FlowRow label={`코스피 ${w.days}일`} f={w.kospi} unit="억원 누적" />
            <FlowRow label={`코스닥 ${w.days}일`} f={w.kosdaq} unit="억원 누적" />
          </div>
        ))}
    </div>
  );
}

/* ── ② 코스피200 선물 ───────────────────────────────────────────────────── */

/**
 * 선물 시세는 `indices` 의 코스피200 칸에 붙어 온다(한투). 투자자별은 네이버에서
 * 따로 받는다 — 우리 서버가 하루치 파일로 들고 있어 호출이 가볍다.
 *
 * **베이시스가 이 카드의 요점이다.** 선물이 현물보다 싸면(백워데이션, 음수) 차익거래가
 * 현물을 팔게 되므로 프로그램 매도가 붙는다.
 */
export function RadarFutures({ indices }: { indices: IndexCard[] | null }) {
  /* 머리띠와 **같은 값**을 쓴다 — 두 번 받을 이유가 없다(`useFuturesFlowToday`) */
  const day = useFuturesFlowToday();
  const k200 = (indices ?? []).find((i) => i.futures) ?? null;
  const f = k200?.futures ?? null;

  if (!f && !day) return <Empty why="선물 시세도 수급도 아직" />;
  return (
    <div className="rdr">
      {f && (
        <>
          <div className="rdr-big">
            <b className={cls(f.changeRate)}>{n0(f.price)}</b>
            <span className={`rdr-big-s ${cls(f.changeRate)}`}>
              {pct(f.changeRate)} <small className="pt-n">전일 대비</small>
            </span>
            <em className="rdr-tag pt-n">{f.name}</em>
          </div>
          <div className="rdr-kv">
            <span>
              <i>베이시스</i>
              <b className={cls(f.basis)}>{f.basis === null ? "-" : f.basis.toFixed(2)}</b>
            </span>
            <span>
              <i>미결제</i>
              <b>{n0(f.openInterest)}</b>
            </span>
            <span>
              <i>거래량</i>
              <b>{n0(f.volume)}</b>
            </span>
          </div>
          {f.basis !== null && (
            <div className="rdr-note pt-n">
              {f.basis < 0
                ? "백워데이션 — 선물이 현물보다 싸다. 차익거래가 현물을 파는 쪽이다"
                : "콘탱고 — 선물이 현물보다 비싸다. 차익거래가 현물을 사는 쪽이다"}
            </div>
          )}
        </>
      )}
      {day && (
        <div className="rdr-sub">
          <FlowRow label={`선물 ${md(day.date)}`} f={day} unit="억원" />
        </div>
      )}
    </div>
  );
}

/* ── ③ 옵션 심리 (VKOSPI) ────────────────────────────── */

/**
 * **벤티지가 말한 「콜·풋 매매 현황」 자리다. 그런데 그 값은 어느 채널에도 없다** (2026-11-24 실측).
 *
 *   1. 한투 국내선물옵션 **43개 기능 전수** — 투자자별 매매동향이 아예 없다
 *   2. 한투 옵션 전광판은 **맨 위 100행만** 준다 — 행사가 1347.5~1595 가 왔는데
 *      코스피200 은 **778** 이다. ATM 근처에도 안 닿으니 풋콜 레이쇼도 못 낸다
 *   3. 네이버는 선물은 주고 **콜/풋은 빈 응답**, 옛 HTML 표는 폐지됐다
 *   4. KRX 정보데이터시스템은 **로그인 벽**으로 바뀜다
 *
 * 그래서 **VKOSPI** 로 메운다. 코스피200 **옵션 값에서 나오는** 변동성지수라
 * 「옵션 쪽이 견어했나」를 말해 주고, `global` 섬션이 이미 받고 있어 **조회가 0회** 늘어난다.
 * 대신 그게 무엇인지와 **못 받는 것이 무엇인지**를 카드 밑에 적어 둔다.
 *
 * VKOSPI 는 정규장에만 움직인다(옵션에서 나오므로) — 밤에는 멈춰 있는 게 맞다.
 */
export function RadarCallPut({ global }: { global: GlobalQuote[] | null }) {
  const v = (global ?? []).find((g) => g.key === "vkospi") ?? null;
  return (
    <div className="rdr">
      {v ? (
        <>
          <div className="rdr-big">
            <b className={cls(v.changeRate)}>{v.price === null ? "-" : v.price.toFixed(2)}</b>
            <span className={`rdr-big-s ${cls(v.changeRate)}`}>
              {pct(v.changeRate)} <small className="pt-n">전일 대비</small>
            </span>
            <em className="rdr-tag pt-n">VKOSPI</em>
          </div>
          {/*
            숫자 하나만 있으면 「20 이 높은 건가」를 모른다. 흔히 쓰는 기준을 같이 적는다 —
            판정이 아니라 **자**다(신호등과 다르다).
          */}
          <div className="rdr-note pt-n">
            코스피200 <b>옵션 값</b>에서 나오는 변동성지수입니다 · 보통 15~20, 30 위면 공포 ·
            정규장에만 움직입니다
          </div>
        </>
      ) : (
        <Empty why="VKOSPI 를 아직 못 받았습니다" />
      )}
      <div className="rdr-note pt-n">
        <b>콜·풋 투자자 수급은 못 붙였습니다</b> — 한투 43개 기능에 없고, 옵션 전광판은
        행사가 맨 위 100개(1347~1595)만 줘서 ATM(778) 근처에 닿지 않고, 네이버는 문을 닫았고,
        KRX 는 로그인이 필요해졌습니다.
      </div>
    </div>
  );
}

/* ── ④ 미국 지수선물 ────────────────────────────────────────────────────── */

/**
 * 나스닥100 선물(`NQ=F`)을 맨 위에 둔다 — 벤티지가 이름을 댄 것이 그것이고, 우리 장
 * 낮 시간에 실제로 움직이는 것도 **현물이 아니라 선물**이다.
 */
export function RadarUsFutures({ global }: { global: GlobalQuote[] | null }) {
  const want = ["nqF", "esF", "ymF", "rtyF", "vix"];
  const rows = (global ?? []).filter((g) => want.includes(g.key)).sort((a, b) => want.indexOf(a.key) - want.indexOf(b.key));
  if (rows.length === 0) return <Empty />;
  return (
    <div className="rdr">
      {rows.map((g) => (
        <div className="rdr-row" key={g.key}>
          <em className="rdr-row-k">{g.label}</em>
          <b className={`rdr-row-v ${cls(g.changeRate)}`}>{g.price === null ? "-" : g.price.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}</b>
          <span className={`rdr-row-p ${cls(g.changeRate)}`}>{pct(g.changeRate)}</span>
        </div>
      ))}
      <div className="rdr-note pt-n">선물은 우리 시간 낮에도 움직입니다 · VIX 만 현물(야후에 VIX 선물이 없습니다)</div>
    </div>
  );
}

/* ── ⑤ 미국 금리 ────────────────────────────────────────────────────────── */

/**
 * **10년은 지금 값, 20년은 전 영업일 확정치다.** 야후가 20년물을 안 줘서 FRED 에서
 * 받는데 FRED 는 하루 늦다 — 그래서 20년 줄에 **날짜를 달아 둔다.** 기준이 다른 숫자를
 * 말없이 나란히 두면 「왜 안 맞아」가 된다(2026-11-20).
 */
export function RadarRates({ usMajor, radar }: { usMajor: UsMajorResult | null; radar: RadarData | null }) {
  const live = (key: string) => (usMajor?.rows ?? []).find((r) => r.key === key) ?? null;
  const y10 = live("tnx");
  const y30 = live("tyx");
  const fred = radar?.usRates ?? null;
  if (!y10 && !fred) return <Empty />;
  return (
    <div className="rdr">
      {y10 && (
        <div className="rdr-row rdr-row4">
          <em className="rdr-row-k">미국 10년</em>
          <b className={`rdr-row-v ${cls(y10.change)}`}>{y10.price === null ? "-" : `${y10.price.toFixed(3)}%`}</b>
          <span className={`rdr-row-p ${cls(y10.change)}`}>{y10.change === null ? "" : `${y10.change > 0 ? "+" : ""}${y10.change.toFixed(3)}`}</span>
          <em className="rdr-row-s pt-n">지금</em>
        </div>
      )}
      <div className="rdr-row rdr-row4">
        <em className="rdr-row-k">미국 20년</em>
        <b className="rdr-row-v">{fred?.y20 === null || fred?.y20 === undefined ? "-" : `${fred.y20.toFixed(2)}%`}</b>
        <span className="rdr-row-p" />
        <em className="rdr-row-s pt-n">{fred?.date ? `${md(fred.date)} 확정` : fred?.why || "없음"}</em>
      </div>
      {y30 && (
        <div className="rdr-row rdr-row4">
          <em className="rdr-row-k">미국 30년</em>
          <b className={`rdr-row-v ${cls(y30.change)}`}>{y30.price === null ? "-" : `${y30.price.toFixed(3)}%`}</b>
          <span className={`rdr-row-p ${cls(y30.change)}`}>{y30.change === null ? "" : `${y30.change > 0 ? "+" : ""}${y30.change.toFixed(3)}`}</span>
          <em className="rdr-row-s pt-n">지금</em>
        </div>
      )}
      <div className="rdr-note pt-n">
        10·30년은 야후 실시간, <b>20년은 FRED 전 영업일 확정치</b>입니다 — 야후에 20년물이 없습니다.
      </div>
    </div>
  );
}

/* ── ⑥ 유가 ─────────────────────────────────────────────────────────────── */

export function RadarOil({ usMajor }: { usMajor: UsMajorResult | null }) {
  const want = ["wti", "brent", "gold"];
  const rows = (usMajor?.rows ?? []).filter((r) => want.includes(r.key)).sort((a, b) => want.indexOf(a.key) - want.indexOf(b.key));
  if (rows.length === 0) return <Empty />;
  return (
    <div className="rdr">
      {rows.map((r) => (
        <div className="rdr-row" key={r.key}>
          <em className="rdr-row-k">{r.label}</em>
          <b className={`rdr-row-v ${cls(r.changeRate)}`}>{r.price === null ? "-" : r.price.toFixed(r.digits ?? 2)}</b>
          <span className={`rdr-row-p ${cls(r.changeRate)}`}>{pct(r.changeRate)}</span>
        </div>
      ))}
      {/* 금을 같이 둔다 — 유가만 보면 「원자재」라기엔 반쪽이고, 금은 금리의 반대편이다 */}
      <div className="rdr-note pt-n">달러 기준 · 금은 금리·달러의 반대편을 읽는 자리입니다</div>
    </div>
  );
}
