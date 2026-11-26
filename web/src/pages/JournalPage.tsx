import { useCallback, useEffect, useRef, useState, type TextareaHTMLAttributes } from "react";
import {
  api,
  fmtNum,
  normalizeStockCode,
  type JournalData,
  type JournalEntry,
  type JournalPick,
  type JournalTrade,
  type PickStats,
  type StockSearchResult,
  type EdgeRow,
  type PrevTradeReview,
  type JournalPosition,
  type JournalWindow,
  type DayContext,
} from "../api";
import { RefreshBar } from "../components/RefreshBar";
import { TradeTrackPanel } from "../components/TradeTrackPanel";
import { IndexIntraday } from "../components/IndexIntraday";
import { useListKeys } from "../useListKeys";

/**
 * 복기 노트.
 *
 * 자유 서술만 있는 매매일지는 **다시 안 읽는 일기**가 된다. 그러면 반성은 남고
 * 개선은 안 남는다. 그래서 실수와 상태를 태그로 고르게 해서 나중에 셀 수 있게 하고,
 * 그날 시장·테마·거래는 자동으로 채운다 — 손으로 적게 하면 안 적고,
 * 적더라도 기억으로 적게 되어 복기의 근거가 흔들린다.
 *
 * 화면 순서가 곧 복기 순서다.
 *   오늘 적기 → 쌓인 나(트래킹) → 지난 기록
 */

function today(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

function pct(n: number | null): string {
  if (n === null) return "-";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

/** 1.5R 미만이면 경고한다 — 이기고도 지는 매매의 경계선 */
const MIN_R = 1.5;

/* ── 날짜 고르기 달력 (2026-08-27) — 캘린더 화면과 같은 문법 ── */
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

function ymdOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function monthOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** 앞 빈칸 + 그 달의 날짜들 */
function buildCalGrid(cursor: Date): (Date | null)[] {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const days = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
  const cells: (Date | null)[] = Array.from({ length: first.getDay() }, () => null);
  for (let i = 1; i <= days; i += 1) cells.push(new Date(cursor.getFullYear(), cursor.getMonth(), i));
  return cells;
}

/**
 * 손절선·목표가를 적으면 **그 자리에서 R 을 보여준다.**
 *
 * 적고 나서 따로 계산하게 하면 아무도 안 한다. 숫자를 넣는 순간 옆에 떠야
 * **주문을 내기 전에** 「이 매매는 1.2R 이네」를 알고 그만둘 수 있다 — 그게 이 칸의 전부다.
 *
 *   R = (목표가 − 진입가) ÷ (진입가 − 손절가)
 *
 * 손절폭(%)도 같이 적는다. R 이 좋아도 손절폭이 15% 면 그건 **손절이 아니라 방치**다.
 */
function PlanReadout({ trade }: { trade: JournalTrade }) {
  const { price = 0, stop = 0, target = 0 } = trade;
  if (!price || !stop) return null;

  // 손절선이 진입가보다 위면 아직 적다 만 것이다 — 그 값으로 R 을 내면 부호가 뒤집힌다
  if (stop >= price) {
    return <i className="jn-plan-warn">손절선이 진입가보다 높습니다</i>;
  }

  const riskPct = ((price - stop) / price) * 100;
  const r = target > price ? (target - price) / (price - stop) : null;

  return (
    <i className="jn-plan-out">
      손절폭 <b>−{riskPct.toFixed(1)}%</b>
      {r !== null && (
        <>
          {" · "}
          <b className={r < MIN_R ? "negative" : "positive"}>{r.toFixed(1)}R</b>
          {r < MIN_R && (
            <span className="jn-plan-warn" title={`${MIN_R}R 미만이면 승률이 높아도 남지 않습니다`}>
              {" "}
              — {MIN_R}R 미만
            </span>
          )}
        </>
      )}
    </i>
  );
}

/**
 * 성적 한 묶음을 표로 — 근거별·신호등별·국면별이 같은 모양이라 하나로 쓴다.
 *
 * **건수를 반드시 같이 적는다.** 세 건 평균 +8% 와 마흔 건 평균 +2% 는 전혀 다른 말인데
 * 평균만 적어 두면 앞의 것이 더 좋아 보인다.
 */
function EdgeTable({ rows }: { rows: EdgeRow[] }) {
  return (
    <div className="jn-edge">
      {rows.map((r) => (
        <div className="cost-row" key={r.key}>
          <span className="cost-name">{r.label}</span>
          <span className={`num jn-edge-ret ${r.avgReturn >= 0 ? "positive" : "negative"}`}>
            {r.avgReturn > 0 ? "+" : ""}
            {r.avgReturn.toFixed(1)}%
          </span>
          <span className="num jn-edge-win">{r.winRate.toFixed(0)}%</span>
          {/*
            **승률 옆에 R 을 붙인다.** 이 둘은 따로 보면 거짓말을 한다 —
            승률 70% 인데 평균 −0.3R 이면 지는 매매인데, 승률만 보면 잘하고 있는 줄 안다.
            손절선을 안 적은 건은 R 을 못 내므로 「-」다. 0 으로 세지 않는다.
          */}
          <span
            className={`num jn-edge-win ${r.avgR === null ? "" : r.avgR >= 0 ? "positive" : "negative"}`}
            title={
              r.avgR === null
                ? "손절선을 적은 매매가 없어 R 을 못 냅니다"
                : `${r.rCount}건에서 낸 평균 R (손절선을 적은 것만)`
            }
          >
            {r.avgR === null ? "-" : `${r.avgR > 0 ? "+" : ""}${r.avgR.toFixed(2)}R`}
          </span>
          <span className="num cost-usd">{r.count}건</span>
        </div>
      ))}
      <div className="jn-stat-note">
        평균 · 승률 · <b>평균 R</b> · 판 건수 순입니다. R 은 <b>손절선을 적어 둔 매매</b>에서만
        나옵니다 — <b>승률보다 R 이 진짜 성적</b>입니다.
      </div>
    </div>
  );
}

const LEVEL_KO: Record<string, string> = {
  green: "🟢 초록장",
  yellow: "🟡 노랑장",
  red: "🔴 빨강장",
  unknown: "기록 없음",
};

/**
 * 예측 복기 (2026-08-27) — **적중률과 그 조건.**
 *
 * 승률 하나만 크게 놓으면 「60%」가 좋은 건지 나쁜 건지 알 수 없다. 그래서 옆에
 * **평균 우위**(예측 방향으로 봤을 때의 평균 등락)를 같이 둔다 — 적중률 55%인데
 * 평균 +1.8% 면 좋은 예측이고, 70%인데 +0.1% 면 잔파도를 맞힌 것이다.
 */
function PickReview({
  picks,
  onSelectStock,
}: {
  picks: PickStats;
  onSelectStock?: (code: string, name: string) => void;
}) {
  if (picks.graded === 0 && picks.pending === 0) {
    return (
      <>
        <h3 className="section-heading">예측 복기</h3>
        <div className="page-note">
          아직 예측이 없습니다 — 위 <b>「내일 예측」</b>에 종목을 담으면 다음 거래일
          종가로 자동 채점되고, 여기에 적중률·시장 상태별 성적이 쌓입니다.
        </div>
      </>
    );
  }

  const rate = (v: number | null) => (v === null ? "-" : `${v.toFixed(0)}%`);
  const edge = (v: number | null) => (v === null ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
  const band = (rows: { n: number; hitRate: number; avgEdge: number }[], labelOf: (i: number) => string) =>
    rows.length === 0 ? (
      <div className="jn-stat-note">아직 셀 게 없습니다.</div>
    ) : (
      <div className="jn-edge">
        {rows.map((r, i) => (
          <div className="cost-row" key={labelOf(i)}>
            <span>{labelOf(i)}</span>
            <span className={`num jn-edge-win ${r.hitRate >= 50 ? "positive" : "negative"}`}>
              {r.hitRate.toFixed(0)}%
            </span>
            <span className={`num ${r.avgEdge >= 0 ? "positive" : "negative"}`}>
              {edge(r.avgEdge)}
            </span>
            <span className="pt-n">{r.n}건</span>
          </div>
        ))}
      </div>
    );

  return (
    <>
      <h3 className="section-heading">예측 복기 — 내 판단이 맞는가</h3>

      <div className="jn-pick-top">
        <div className="jn-pick-big">
          <span className="jn-pick-big-k">적중률</span>
          <b className={`jn-pick-big-v ${(picks.hitRate ?? 0) >= 50 ? "positive" : "negative"}`}>
            {rate(picks.hitRate)}
          </b>
          <span className="pt-n">{picks.graded}건 채점</span>
        </div>
        <div className="jn-pick-big">
          <span className="jn-pick-big-k">평균 우위</span>
          <b className={`jn-pick-big-v ${(picks.avgEdge ?? 0) >= 0 ? "positive" : "negative"}`}>
            {edge(picks.avgEdge)}
          </b>
          <span className="pt-n">예측 방향으로 본 등락</span>
        </div>
        <div className="jn-pick-big">
          <span className="jn-pick-big-k">방향별</span>
          <b className="jn-pick-big-v">
            ▲{rate(picks.up.hitRate)} / ▼{rate(picks.down.hitRate)}
          </b>
          <span className="pt-n">
            오름 {picks.up.n}건 · 내림 {picks.down.n}건
          </span>
        </div>
        {/* 나아지고 있나 (2026-08-29) — 누적 하나만 보면 훈련이 되는지가 안 보인다 */}
        {picks.trend.recent !== null && (
          <div className="jn-pick-big">
            <span className="jn-pick-big-k">최근 {picks.trend.recentN}건</span>
            <b
              className={`jn-pick-big-v ${
                picks.trend.earlier === null
                  ? ""
                  : picks.trend.recent >= picks.trend.earlier
                    ? "positive"
                    : "negative"
              }`}
            >
              {rate(picks.trend.recent)}
            </b>
            <span className="pt-n">
              {picks.trend.earlier === null
                ? "이전과 견줄 만큼은 아직"
                : `이전 ${picks.trend.earlierN}건 ${rate(picks.trend.earlier)}`}
            </span>
          </div>
        )}
        {picks.pending > 0 && (
          <div className="jn-pick-big">
            <span className="jn-pick-big-k">채점 대기</span>
            <b className="jn-pick-big-v">{picks.pending}건</b>
            <span className="pt-n">다음 거래일 종가로</span>
          </div>
        )}
      </div>

      {/*
        **쪼갠 통계는 접는다** (2026-11-25 — 벤티지: "구조가 너무 복잡하고 알아먹기 힘들다").
        시장 상태별·신호등별·선물 수급별·종목별은 **표본이 쌓여야 말을 한다.** 그 전까지는
        자리만 먹는다. 지우지 않고 접어 둔다 — 몇 달 뒤에 볼 것이다.
      */}
      <details className="jn-fold">
      <summary>쪼개 보기 — 시장 상태별 · 신호등별 · 선물 수급별 · 종목별</summary>
      <div className="jn-stats">
        <div className="jn-stat-block">
          <div className="cost-sub">시장 상태별 — 어떤 판에서 맞았나</div>
          {band(picks.byMarket, (i) => LEVEL_KO[picks.byMarket[i].level] ?? picks.byMarket[i].level)}
          <div className="jn-stat-note">
            초록장에서만 맞으면 시장을 따라간 것이고, 빨강장에서도 맞으면 판단입니다.
          </div>
        </div>

        {picks.bySignal.length > 0 && (
          <div className="jn-stat-block">
            <div className="cost-sub">종목 신호등별 — 그때 그 종목이 무슨 색이었나</div>
            {band(picks.bySignal, (i) => LEVEL_KO[picks.bySignal[i].level] ?? picks.bySignal[i].level)}
            <div className="jn-stat-note">
              초록일 때만 잘 맞으면 신호등을 걸러 쓰면 되고, 색과 무관하게 비슷하면
              예측에는 신호등이 안 통하는 것입니다.
            </div>
          </div>
        )}

        <div className="jn-stat-block">
          <div className="cost-sub">선물 외국인 수급별 — 그날 국장 선물</div>
          {band(picks.byFutures, (i) => `선물 ${picks.byFutures[i].band}`)}
          <div className="jn-stat-note">±5,000억 기준 (시장 신호등의 선물 체크와 같은 문턱 · 9/17 까지의 기록은 계약 단위라 ±2,000)</div>
        </div>

        {picks.byStock.length > 0 && (
          <div className="jn-stat-block wide">
            <div className="cost-sub">종목별 — 2회 이상 예측한 것</div>
            <div className="jn-edge">
              {picks.byStock.map((r) => (
                <div className="cost-row" key={r.code}>
                  <button
                    className="link-btn"
                    onClick={() => onSelectStock?.(r.code, r.name)}
                    title="종목 상세"
                  >
                    {r.name}
                  </button>
                  <span className={`num jn-edge-win ${r.hitRate >= 50 ? "positive" : "negative"}`}>
                    {r.hitRate.toFixed(0)}%
                  </span>
                  <span className={`num ${r.avgEdge >= 0 ? "positive" : "negative"}`}>
                    {edge(r.avgEdge)}
                  </span>
                  <span className="pt-n">{r.n}건</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      </details>

      {/* 히스토리 — 그날 무엇을 보고 무엇을 예측했고 어떻게 됐나 */}
      {picks.recent.length > 0 && (
        <details className="cal-fold jn-pick-hist">
          <summary>예측 히스토리 ({picks.recent.length}건)</summary>
          {picks.recent.map((r, i) => (
            <div className={`jn-pick-row ${r.hit ? "hit" : "miss"}`} key={`${r.date}-${r.code}-${i}`}>
              <div className="jn-pick-row-head">
                <span className="pt-n">{r.date.slice(5)}</span>
                <button className="link-btn" onClick={() => onSelectStock?.(r.code, r.name)}>
                  {r.name}
                </button>
                <span className={`jn-pick-dir ${r.dir}`}>{r.dir === "up" ? "▲" : "▼"}</span>
                <span className={`jn-pick-res ${r.hit ? "hit" : "miss"}`}>
                  {r.hit ? "적중" : "빗나감"} {r.rate > 0 ? "+" : ""}
                  {r.rate.toFixed(2)}%
                </span>
                <span className="pt-n">→ {r.gradedAt.slice(4, 6)}/{r.gradedAt.slice(6, 8)} 종가</span>
              </div>
              <div className="jn-pick-row-ctx">
                {r.market && (
                  <span>
                    <span className={`sig-dot ${r.market.level}`} /> 시장 {r.market.score}점
                  </span>
                )}
                {r.signal && (
                  <span>
                    종목 신호등 <b>{r.signal.score}점</b>
                  </span>
                )}
                {r.note && <span className="jn-pick-note">“{r.note}”</span>}
              </div>
            </div>
          ))}
        </details>
      )}
    </>
  );
}


/**
 * **적은 만큼 보이는 칸** (2026-11-25 — 벤티지: "복기노트에 적은 글들이 칸이 좁아서 안보여.
 * 저장하고 나면 인풋창 말고 전체 글로 보여줄 수는 없나?").
 *
 * `rows={2}` 고정이라 **세 줄째부터는 적어 놓고도 못 읽었다.** 복기는 쓰면서 위를 다시
 * 읽는 글이라, 읽으려고 칸 안에서 스크롤을 해야 하면 그 자리에서 생각이 끊긴다.
 *
 * ## 「저장하면 전문 · 수정 누르면 입력창」을 안 쓴 까닭
 *
 * 벤티지가 그 방법도 말했는데, 그러면 **상태가 하나 더 생긴다** — 저장 안 하고 나가면
 * 어떻게 되나, 지금이 보는 중인가 쓰는 중인가, 고치려면 탭을 한 번 더. 폰에서 쓰는
 * 화면에 모드 전환을 두는 값이 비싸다.
 *
 * **칸이 내용만큼 자라면 그 물음이 통째로 사라진다.** 늘 전문이 보이고 늘 고칠 수 있다.
 *
 * 최대 높이를 둔 것은 길게 쓴 날 한 칸이 화면을 다 먹지 않게 하려는 것이다 — 그때만
 * 예전처럼 안쪽 스크롤이 생긴다.
 */
const JN_MAX_H = 420;

function AutoText({ minRows = 2, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    /* 줄였다 늘릴 때를 위해 **먼저 auto 로 풀어야** scrollHeight 가 줄어든 높이를 준다 */
    el.style.height = "auto";
    const want = el.scrollHeight + 2;
    el.style.height = `${Math.min(want, JN_MAX_H)}px`;
    el.style.overflowY = want > JN_MAX_H ? "auto" : "hidden";
  }, []);
  /* 값이 밖에서 바뀔 때(불러오기·초기화)도 맞춰야 한다 — 타이핑만 보면 안 된다 */
  useEffect(fit, [fit, rest.value]);
  return <textarea ref={ref} rows={minRows} onInput={fit} {...rest} />;
}


/**
 * **일일복기 프롬프트** (2026-11-25) — 벤티지가 업노트에 적어 두고 손으로 옮기던 글.
 *
 * 4관점(시황 동기화 / 매매일지·원칙 점검 / 익일 대응 전략 검증 / 연금·ETF 배분)과
 * 끝의 당부(「칭찬이나 감정적인 말은 빼고, 오직 팩트와 원칙에 기반해서」)를 **그대로** 옮겼다.
 * 내가 고쳐 쓰면 그건 더 이상 그의 복기가 아니다.
 *
 * 그날 숫자는 이미 박제돼 있으므로 **프롬프트에 같이 실어 보낸다** — 시스가 다시 조회할
 * 이유가 없고, 무엇보다 **그가 보던 값과 같은 값**으로 판단해야 복기가 맞물린다.
 */
function buildReviewPrompt(
  f: Partial<JournalEntry>,
  ctx: DayContext | null,
  prev: { date: string | null; rows: PrevTradeReview[] } | null,
  creed: string,
): string {
  const L: string[] = [];
  const push = (k: string, v?: string | null) => {
    if (v && String(v).trim()) L.push(`${k}: ${String(v).trim()}`);
  };

  L.push("[시스, 오늘 복기 노트 연동 피드백 요청]");
  L.push("오늘 내 복기 노트를 바탕으로 아래 4가지 관점에서 냉정하고 객관적인 CIS 모드 분석을 해줘.");
  L.push("");
  L.push("1. 당일 핵심 시황 & 뉴스 동기화: 오늘 증시 수급(외인/기관)과 주요 뉴스/테마가 내 복기 내용과 일치하는지 체크. 내가 놓친 핵심 매매 포인트나 시장의 진짜 돈의 흐름(주도주)이 있었는지 분석");
  L.push("2. 매매 일지 & 원칙 점검: 보유/무포지션 판단과 편출입 과정에서 '이격도 밀착 타점', '추세 준수', '손절 원칙'이 잘 지켜졌는지 평가. 뇌동매매나 복구 심리가 개입된 위험한 판단(신용, 추격매수 등)이 있었는지 경고");
  L.push("3. 익일 대응 전략 검증: 내가 설정한 '신규 편입 예상 종목/전략'의 승률과 손익비 평가. 미장 선물, 환율, 원유 등 글로벌 변수와 연계했을 때 내일 아침 실제 유효한 진입 기준(매수 타점/손절선) 제시");
  L.push("4. 연금/ETF 및 자산 배분 피드백: 연금 계좌 및 포트폴리오 비중 조절이 장기 추세와 잘 맞아떨어지는지 점검");
  L.push("");
  L.push("칭찬이나 감정적인 말은 빼고, 오직 팩트와 원칙에 기반해서 내일 매매에 바로 적용할 수 있는 구체적인 실행 지침을 줘.");
  L.push("");
  L.push("── 오늘 박제된 시장 ──");
  if (ctx) {
    if (ctx.marketSummary) L.push(`시장 신호등: ${ctx.marketLevel} ${ctx.marketScore}점 — ${ctx.marketSummary}`);
    (ctx.indices ?? []).forEach((i: NonNullable<DayContext["indices"]>[number]) => L.push(`${i.name} ${i.close.toLocaleString("ko-KR")} ${i.rate > 0 ? "+" : ""}${i.rate}% (▲${i.up} ▼${i.down})`));
    if (ctx.futuresQuote) L.push(`선물 ${ctx.futuresQuote.price ?? "-"} ${ctx.futuresQuote.rate ?? "-"}% · 베이시스 ${ctx.futuresQuote.basis ?? "-"}`);
    if (ctx.investor) {
      L.push(`수급(억) 코스피 외 ${ctx.investor.kospi.foreign} 기 ${ctx.investor.kospi.institution} 개 ${ctx.investor.kospi.individual}`);
      L.push(`수급(억) 코스닥 외 ${ctx.investor.kosdaq.foreign} 기 ${ctx.investor.kosdaq.institution} 개 ${ctx.investor.kosdaq.individual}`);
    }
    if (ctx.futures) L.push(`선물 수급(억) 외 ${ctx.futures.foreign} 기 ${ctx.futures.institution} 개 ${ctx.futures.individual}`);
    if (ctx.usRates) L.push(`미국 10년 ${ctx.usRates.y10 ?? "-"} · 30년 ${ctx.usRates.y30 ?? "-"}`);
    if (ctx.overseas) L.push(`나스닥100선물 ${ctx.overseas.nasdaqFut ?? "-"} (${ctx.overseas.nasdaqFutRate ?? "-"}%) · VKOSPI ${ctx.overseas.vkospi ?? "-"}`);
    if (ctx.topThemes?.length) L.push(`강한 테마: ${ctx.topThemes.map((t: { name: string; changeRate: number }) => `${t.name} ${t.changeRate.toFixed(2)}%`).join(", ")}`);
  } else {
    L.push("(아직 박제 전 — 저장하면 그날 시장이 함께 들어간다)");
  }

  L.push("");
  L.push("── 내 기록 ──");
  push("오늘", f.stance === "watch" ? "관망(안 샀다)" : f.stance === "trade" ? "매매함" : null);
  push("본 섹터", f.watchSector);
  push("본 종목", f.watchStocks);
  (f.trades ?? []).forEach((t) => {
    const bits = [`${t.kind === "buy" ? "매수" : "매도"} ${t.name} ${t.price.toLocaleString("ko-KR")}원 ${t.qty}주`];
    if (t.stop) bits.push(`손절 ${t.stop.toLocaleString("ko-KR")}`);
    if (t.target) bits.push(`목표 ${t.target.toLocaleString("ko-KR")}`);
    if (t.reasons?.length) bits.push(`근거 ${t.reasons.join("·")}`);
    if (t.note) bits.push(`"${t.note}"`);
    L.push(bits.join(" · "));
  });
  push("무엇을 했나", f.what);
  push("왜 그렇게 판단했나", f.why);
  push("규칙", f.followedRules === true ? "지켰다" : f.followedRules === false ? `어겼다 — ${f.brokenRule ?? ""}` : null);
  push("실수", (f.mistakes ?? []).join(", "));
  push("상태", f.mood);
  push("배운 것", f.lesson);
  push("내일 할 것", f.tomorrow);

  if (prev?.date && prev.rows.length > 0) {
    L.push("");
    L.push(`── 전일(${prev.date}) 매매가 지금 ──`);
    prev.rows.forEach((r) =>
      L.push(
        `${r.kind === "buy" ? "매수" : "매도"} ${r.name} ${r.price.toLocaleString("ko-KR")}` +
          (r.now !== null ? ` → ${r.now.toLocaleString("ko-KR")} (${r.change !== null ? `${r.change > 0 ? "+" : ""}${r.change}%` : "?"})` : " → 지금 값 없음") +
          (r.hitStop ? " · 손절선 닿음" : r.hitTarget ? " · 목표가 닿음" : ""),
      ),
    );
    push("전일 복기 고찰", f.prevReview);
  }

  if (creed.trim()) {
    L.push("");
    L.push("── 내 원칙(이 기준으로 점검해라) ──");
    L.push(creed.trim());
  }
  return L.join("\n");
}

export function JournalPage({
  onSelectStock,
}: {
  onSelectStock?: (code: string, name: string) => void;
} = {}) {
  const [data, setData] = useState<JournalData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [date, setDate] = useState(today());

  /*
   * **전일 매매복기** (2026-11-25 — 벤티지 2023 목차의 「전일 매매복기」).
   *
   * 어제 산 것이 오늘 어떻게 됐는지는 **기계가 채점한다**. 값은 서버의 전종목 스냅샷
   * 캐시에서 읽으므로 조회가 안 는다. 사람이 적을 것은 그걸 보고 드는 생각뿐이다.
   */
  /*
   * **응답 순서 지킴** (2026-11-25 — 실측으로 당했다). 날짜를 빠르게 넘기면 **먼저 보낸
   * 요청의 늦은 응답**이 새 것을 덮는다. 화면에 11/25 값이 떠 있는데 네트워크는 11/26 을
   * 받아 온 상태였다. 이 파일의 다른 로더들(`naverSeq`·`mineSeq`)이 같은 이유로 같은
   * 가드를 쓴다 — 나만 빼먹었다.
   */
  const revSeq = useRef(0);
  const posSeq = useRef(0);
  const [prevRev, setPrevRev] = useState<{ date: string | null; rows: PrevTradeReview[] } | null>(null);
  /** 내 종목 현황 — 「내 매매가 어땠나」에 바로 답하는 값 (2026-11-25) */
  const [positions, setPositions] = useState<JournalPosition[]>([]);
  useEffect(() => {
    const seq = ++posSeq.current;
    api
      .journalPositions(date)
      .then((r) => seq === posSeq.current && setPositions(r.rows))
      .catch(() => seq === posSeq.current && setPositions([]));
  }, [date]);

  /**
   * **구간별 매매·수익 현황** (2026-11-27 — 벤티지: "밑에 내 매매 이거 의미가 뭐야? …
   * 5일간 매매 현황&수익현황. 10일 현황. 20일 현황 이렇게 구간별로 볼 수 있게").
   */
  const [windows, setWindows] = useState<JournalWindow[]>([]);
  const winSeq = useRef(0);
  useEffect(() => {
    const seq = ++winSeq.current;
    api
      .journalWindows(date)
      .then((r) => seq === winSeq.current && setWindows(r.windows))
      .catch(() => seq === winSeq.current && setWindows([]));
  }, [date]);

  /**
   * **아직 저장 안 한 날의 시장** (2026-11-27 — 벤티지: "저장하고 나면 코스피 코스닥 이런거
   * 지수현황 보이는데 처음에 기록할때도 보일 수 있게").
   *
   * 저장할 때 박히는 것과 **같은 함수**를 서버에서 부른다 — 두 벌로 만들면 적을 때 본
   * 숫자와 박힌 숫자가 갈리는 날이 온다. 저장본이 있으면 안 부른다(박제가 우선).
   */
  const [liveCtx, setLiveCtx] = useState<DayContext | null>(null);
  const ctxSeq = useRef(0);
  useEffect(() => {
    const saved = data?.entries.find((e) => e.date === date)?.context ?? null;
    if (saved) {
      setLiveCtx(null);
      return;
    }
    const seq = ++ctxSeq.current;
    api
      .journalContext(date)
      .then((r) => seq === ctxSeq.current && setLiveCtx(r.context))
      .catch(() => seq === ctxSeq.current && setLiveCtx(null));
  }, [date, data]);

  /**
   * **설명은 접어 둔다** (2026-11-27 — 벤티지: "설명들 다 접힘 모드 기본으로 해줘
   * 화면만 먹어").
   *
   * 칸마다 붙은 한 줄 설명은 **처음 한 번만** 쓸모가 있다. 매일 쓰는 사람에게는 읽을
   * 것과 적을 것 사이에 낀 군더더기다 — 폰에서는 그것 때문에 한 칸이 두 배로 길어진다.
   * 지우지는 않는다(가끔 「이 칸이 뭐였지」가 온다). 기기별(localStorage)로 기억한다.
   */
  const [hints, setHints] = useState(() => {
    try {
      return localStorage.getItem("vntg.journal.hints") === "1";
    } catch {
      return false;
    }
  });
  const toggleHints = () => {
    const v = !hints;
    setHints(v);
    try {
      localStorage.setItem("vntg.journal.hints", v ? "1" : "0");
    } catch {
      /* 사생활 모드 — 이번만 */
    }
  };

  /*
   * **시스에게 복기 받기** (2026-11-25). 벤티지의 업노트에는 `[일일복기 프롬프트]` 가 있었다 —
   * 4관점(시황 동기화 / 원칙 점검 / 익일 전략 검증 / 연금·ETF 배분)으로 AI 에게 시키는 글.
   *
   * 그걸 **손으로 옮겨 붙이고 있었다.** 그날 숫자와 글이 이미 이 화면에 다 모여 있으니
   * 버튼 하나면 된다. 답은 `aiReview` 로 따로 저장한다 — **사람 글을 덮지 않는다.**
   */
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);

  /** #매일읽기 — 서버에 저장된 내 원칙 */
  const [creed, setCreed] = useState<{ text: string; updatedAt: string } | null>(null);
  const [creedOpen, setCreedOpen] = useState(false);
  const [creedEdit, setCreedEdit] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .journalCreed()
      .then((c) => alive && setCreed(c))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    const seq = ++revSeq.current;
    api
      .journalPrevReview(date)
      .then((r) => seq === revSeq.current && setPrevRev(r))
      .catch(() => seq === revSeq.current && setPrevRev(null));
  }, [date]);

  /** 달력이 보고 있는 달 — 날짜와 따로 논다(지난달을 넘겨봐도 고른 날은 그대로) */
  const [calCursor, setCalCursor] = useState(() => new Date());

  // 편집 중인 값
  const [form, setForm] = useState<Partial<JournalEntry>>({});
  /*
   * ✂ 11번 「오늘의 주문·체결」은 2026-11-27 에 걷어냈다 — 벤티지가 메인 계좌에서
   * 거래해서 늘 비어 있었다. 서버 쪽(`/journal/orders`)과 저장본의 `orders` 는 그대로다
   * (주문 메뉴의 「복기 노트에 담기」가 쓴다). 여기서 날짜마다 부르던 조회도 같이 없앤다 —
   * 그 길은 키움 당일매매일지(ka10170)까지 불렀다.
   */
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StockSearchResult[]>([]);
  /* 예측 종목 검색 — 매매 검색과 칸을 나눈다(같이 쓰면 어느 쪽에 담을지 헷갈린다) */
  const [pickQuery, setPickQuery] = useState("");
  const [pickResults, setPickResults] = useState<StockSearchResult[]>([]);

  /*
   * ⚠️ **저장 안 된 편집을 지키는 장치** (2026-08-25).
   *
   * 「관망 누르고 사유까지 골랐는데 날짜를 바꿨다 돌아오니 사라졌다」 — 실제로 났다.
   * 날짜를 바꾸면 그날 저장본을 폼에 올리는데, 그 전에 **지금 폼이 저장됐는지 아무도
   * 안 봤다.** 다른 메뉴로 나가도(언마운트) 똑같이 날아갔다.
   *
   * 마지막으로 불러오거나 저장한 폼의 스냅샷을 들고 있다가, 다르면 「편집 중」이다.
   * 편집 중인 채로 (1) 날짜를 바꾸면 먼저 저장하고 넘어가고 (2) 화면을 떠나면
   * 저장을 쏘고 떠난다. 지우는 게 목적일 수는 없다 — 지우기는 저장으로만 한다.
   */
  const savedSnap = useRef("{}");
  const snap = (f: Partial<JournalEntry>) =>
    JSON.stringify({ ...f, context: undefined, updatedAt: undefined });
  /** 빈 폼을 자동 저장하면 「본 날」이 「기록한 날」이 된다 — 내용이 있어야 저장한다 */
  const meaningful = (f: Partial<JournalEntry>) =>
    Boolean(
      f.stance ||
        (f.trades ?? []).length > 0 ||
        (f.mistakes ?? []).length > 0 ||
        f.followedRules !== null ||
        (f.what ?? "").trim() ||
        (f.why ?? "").trim() ||
        (f.mood ?? "").trim() ||
        (f.lesson ?? "").trim() ||
        (f.tomorrow ?? "").trim() ||
        (f.brokenRule ?? "").trim(),
    );
  const dirty = snap(form) !== savedSnap.current;

  /** 언마운트 자동 저장이 읽을 최신값 — 클로저에 갇힌 옛 폼을 쏘면 안 된다 */
  const live = useRef({ form, date, dirty: false });
  live.current = { form, date, dirty };
  useEffect(
    () => () => {
      const l = live.current;
      if (l.dirty && meaningful(l.form)) {
        // 떠나는 길이라 결과를 기다릴 수 없다 — 실패하면 다음에 열 때 없는 것으로 보인다
        void api.journalSave({ ...l.form, date: l.date }).catch(() => {});
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .searchStocks(q)
        .then((r) => setResults(r.results))
        .catch(() => setResults([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const q = pickQuery.trim();
    if (!q) {
      setPickResults([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .searchStocks(q)
        .then((r) => setPickResults(r.results))
        .catch(() => setPickResults([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [pickQuery]);

  const EMPTY_FORM: Partial<JournalEntry> = {
    mistakes: [],
    followedRules: null,
    mood: "",
    trades: [],
    picks: [],
  };

  /** 폼을 올리면서 스냅샷도 같이 — 이 순간이 「저장된 상태」의 기준이 된다 */
  function applyForm(hit: JournalEntry | undefined) {
    const f = hit ?? EMPTY_FORM;
    setForm(f);
    savedSnap.current = snap(f);
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const d = await api.journal();
      setData(d);
      /* 편집 중이면 폼을 안 덮는다 — 새로고침이 지우개가 되면 안 된다 */
      if (!live.current.dirty) applyForm(d.entries.find((e) => e.date === date));
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(): Promise<{ entries: JournalEntry[] } | null> {
    setSaving(true);
    setNote(null);
    try {
      const d = await api.journalSave({ ...form, date });
      setData((prev) => (prev ? { ...prev, entries: d.entries, stats: d.stats } : prev));
      savedSnap.current = snap(form);
      setNote("저장했습니다.");
      return d;
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 실패");
      return null;
    } finally {
      setSaving(false);
    }
  }

  /**
   * 날짜를 바꾼다 — **편집 중이면 먼저 저장하고** 넘어간다.
   * 예전엔 날짜만 바꾸면 폼을 그날 저장본으로 갈아끼웠다. 저장 안 한 편집은
   * 그 순간 소리 없이 사라졌다 — 실제로 관망 사유를 잃었다.
   */
  async function switchDate(next: string) {
    if (next === date) return;
    let entries = data?.entries ?? [];
    if (dirty && meaningful(form)) {
      const saved = await save();
      if (!saved) return; // 저장이 실패했으면 날짜를 안 바꾼다 — 편집을 버리는 길이 없다
      entries = saved.entries;
    }
    setDate(next);
    setNote(null);
    // 다른 달의 날을 고르면 달력도 따라간다
    const [y, m] = next.split("-").map(Number);
    setCalCursor(new Date(y, m - 1, 1));
    applyForm(entries.find((e) => e.date === next));
  }

  /* ── 달력 (2026-08-27) — 한 달치를 펴 놓고 눌러서 고른다 ── */
  const shiftCal = (d: number) =>
    setCalCursor((c) => new Date(c.getFullYear(), c.getMonth() + d, 1));
  async function goToday() {
    setCalCursor(new Date());
    await switchDate(today());
  }
  /** 기록이 있는 날 — 달력에 점을 찍어 빈 날이 보이게 한다 */
  const written = new Set((data?.entries ?? []).map((e) => e.date));

  function addTrade(r: StockSearchResult | null) {
    const t: JournalTrade = {
      id: `jt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      kind: "buy",
      code: r ? normalizeStockCode(r.code) : "",
      name: r ? r.name : "",
      price: 0,
      qty: 0,
      note: "",
    };
    setForm({ ...form, trades: [...(form.trades ?? []), t] });
    setQuery("");
    setResults([]);
  }

  /* ── 예측 종목 (2026-08-27) ── */
  function addPick(r: StockSearchResult) {
    const p: JournalPick = {
      id: `jp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      code: normalizeStockCode(r.code),
      name: r.name,
      dir: "up",
      note: "",
    };
    setForm({ ...form, picks: [...(form.picks ?? []), p] });
    setPickQuery("");
    setPickResults([]);
  }

  /* 화면에 그리는 것도 여덟 개까지라 훅에 넘기는 목록도 똑같이 잘라 인덱스를 맞춘다 */
  const tradeCands = results.slice(0, 8);
  const tradeKeys = useListKeys(tradeCands, addTrade, { itemClass: "" });
  const pickCands = pickResults.slice(0, 8);
  const pickKeys = useListKeys(pickCands, addPick, { itemClass: "" });

  function patchPick(id: string, patch: Partial<JournalPick>) {
    setForm({
      ...form,
      picks: (form.picks ?? []).map((p) => (p.id === id ? { ...p, ...patch } : p)),
    });
  }

  function removePick(id: string) {
    setForm({ ...form, picks: (form.picks ?? []).filter((p) => p.id !== id) });
  }

  function patchTrade(id: string, patch: Partial<JournalTrade>) {
    setForm({
      ...form,
      trades: (form.trades ?? []).map((t) => (t.id === id ? { ...t, ...patch } : t)),
    });
  }

  function removeTrade(id: string) {
    setForm({ ...form, trades: (form.trades ?? []).filter((t) => t.id !== id) });
  }

  function toggleMistake(key: string) {
    const cur = form.mistakes ?? [];
    setForm({ ...form, mistakes: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key] });
  }

  if (loading && !data) return <div className="page-note">불러오는 중…</div>;
  if (!data) return <div className="error-banner">{error ?? "복기 노트를 열 수 없습니다."}</div>;

  const s = data.stats;
  const entry = data.entries.find((e) => e.date === date);
  /*
   * 저장본이 **먼저**다. 박제된 값이 있으면 그게 그날의 기록이고, 없을 때만 지금 값을
   * 빌려 온다 — 적는 동안 보라고(2026-11-27). 둘을 섞지 않으려고 `ctxLive` 로 표시한다.
   */
  const savedCtx = entry?.context ?? null;
  const ctx = savedCtx ?? liveCtx;
  const ctxLive = !savedCtx && !!liveCtx;
  const calGrid = buildCalGrid(calCursor);

  return (
    <div>
      <RefreshBar onRefresh={load} loading={loading} />
      {error && <div className="error-banner">{error}</div>}

      {/* ── 오늘 적기 ── */}
      {/*
        칸마다 붙은 한 줄 설명은 **처음 한 번만** 쓸모가 있다. 기본은 접음 —
        지우지 않고 CSS 한 줄로 감춘다(`jn-nohint`). 기억은 기기별이다.
      */}
      <section className={`jn-editor${hints ? "" : " jn-nohint"}`}>
        {/*
          날짜 고르기 — **한 달치 달력** (2026-08-27). 예전엔 `<input type="date">` 라
          네이티브 피커를 열어 두 번 눌러야 했고, 어느 날에 기록이 있는지도 안 보였다.
          달력이면 한 번에 고르고, **기록이 있는 날에 점**이 찍혀 빈 날이 바로 보인다.
        */}
        <div className="jn-head">
          <button className="filter-btn" onClick={() => shiftCal(-1)} title="이전 달">
            ‹
          </button>
          <b className="jn-cal-month">
            {calCursor.getFullYear()}년 {calCursor.getMonth() + 1}월
          </b>
          <button
            className="filter-btn"
            onClick={() => shiftCal(1)}
            disabled={monthOf(calCursor) >= monthOf(new Date())}
            title="다음 달"
          >
            ›
          </button>
          <button className="filter-btn" onClick={() => void goToday()} title="오늘로">
            오늘
          </button>
          {/* 칸 설명 — 기본은 접힘. 「이 칸이 뭐였지」가 올 때만 편다 */}
          <button
            className={`filter-btn ${hints ? "active" : ""}`}
            onClick={toggleHints}
            title="칸마다 붙은 한 줄 설명을 보이거나 감춥니다 (이 기기에 기억됩니다)"
          >
            설명 {hints ? "끄기" : "보기"}
          </button>
          <span className="jn-streak">
            연속 <b>{s.streak}</b>일 · 총 <b>{s.days}</b>일 기록
          </span>
          {dirty && !saving && <span className="jn-dirty">● 편집 중</span>}
        </div>

        <div className="jn-cal">
          {WEEKDAYS.map((w, i) => (
            <div className={`cal-wd${i === 0 ? " sun" : i === 6 ? " sat" : ""}`} key={w}>
              {w}
            </div>
          ))}
          {calGrid.map((d, i) => {
            if (!d) return <span className="jn-cal-cell empty" key={`e${i}`} />;
            const key = ymdOf(d);
            const future = key > today();
            return (
              <button
                key={key}
                className={`jn-cal-cell${key === date ? " on" : ""}${key === today() ? " today" : ""}${
                  written.has(key) ? " has" : ""
                }`}
                disabled={future}
                onClick={() => void switchDate(key)}
                title={written.has(key) ? "기록 있음" : "기록 없음"}
              >
                {d.getDate()}
              </button>
            );
          })}
        </div>

        {/* 자동으로 잡힌 그날 맥락 — 사용자가 적을 필요가 없다 */}
        {ctx ? (
          <div className="jn-ctx">
            <span className={`sig-dot ${ctx.marketLevel}`} />
            <span className="jn-ctx-main">{ctx.marketSummary || "시장 기록 없음"}</span>
            {ctx.breadth && <span className="jn-ctx-sub">{ctx.breadth}</span>}
            {ctx.topThemes.length > 0 && (
              <span className="jn-ctx-sub">
                강한 테마 {ctx.topThemes.map((t) => `${t.name} ${pct(t.changeRate)}`).join(", ")}
              </span>
            )}
          </div>
        ) : (
          <div className="page-note">
            저장하면 그날의 <b>지수·수급·선물·금리·테마</b>가 자동으로 함께 박제됩니다.
          </div>
        )}

        {/*
          **장중 등락률** (2026-11-27 — 벤티지: "장중 등락률 그래프도 보여줘서 오늘 장
          분위기 알 수 있게 하자고"). 숫자는 「얼마나」만 말하고 **「어떻게」를 못 말한다** —
          +0.3% 로 끝난 날이 내리 밀리다 끝에 붙은 날인지, 아침에 다 벌고 흘린 날인지는
          선이라야 보인다. 복기에서 묻는 것이 바로 그것이다.

          오늘 자리에서만 그린다 — 이 그림은 **가장 최근 거래일**을 그리므로, 지난 날짜에
          붙이면 그날이 아닌 오늘을 그려 놓고 그날인 척하게 된다.
        */}
        {date === today() && <IndexIntraday />}

        {/*
          **[지수 현황]** (2026-11-25 — 벤티지의 업노트/블로그에서 매일 손으로 캡처해
          붙이던 표). 이제 저장할 때 숫자로 박히므로 캡처가 필요 없고, 무엇보다
          **나중에 셀 수 있다** — 「외국인이 산 날의 내 성적」 같은 물음이 그때 가능해진다.

          ⚠️ 현물 수급(억원)과 선물 수급(계약)을 **다른 줄**로 둔다. 업노트 표에서도
          칸이 갈려 있었다 — 한 줄에 섞으면 「외국인이 샀다」가 어느 쪽인지 사라진다.
        */}
        {ctx && (ctx.indices || ctx.investor || ctx.usRates) && (
          <div className="jn-mkt">
            <div className="jn-mkt-h">
              [지수 현황]{" "}
              <em className="pt-n">{ctxLive ? "지금 값 — 저장하면 이대로 박제됩니다" : "저장할 때 박제된 값"}</em>
            </div>

            {/*
              **카드로 묶는다** (2026-11-26 — 벤티지: "이거 카드형식으로 보여줘야 눈에 확
              들어올듯"). 넓은 화면에서 이름과 값이 **화면 양 끝으로 벌어져** 눈이 가로로
              한참을 달려야 했다. 카드는 이름·값·단서가 **한 뼘 안에** 모인다.
            */}
            {ctx.indices && ctx.indices.length > 0 && (
              <div className="jn-cards">
                {ctx.indices.map((i) => (
                  <div className="jn-card" key={i.name}>
                    <em>{i.name}</em>
                    <b className="num">{i.close.toLocaleString("ko-KR")}</b>
                    <span className={`num ${i.rate > 0 ? "positive" : i.rate < 0 ? "negative" : ""}`}>{pct(i.rate)}</span>
                    <small className="pt-n">▲{i.up} ▼{i.down}</small>
                  </div>
                ))}
                {ctx.futuresQuote && (
                  <div className="jn-card">
                    <em>선물</em>
                    <b className="num">{ctx.futuresQuote.price?.toLocaleString("ko-KR") ?? "-"}</b>
                    <span className={`num ${(ctx.futuresQuote.rate ?? 0) > 0 ? "positive" : (ctx.futuresQuote.rate ?? 0) < 0 ? "negative" : ""}`}>
                      {ctx.futuresQuote.rate === null ? "-" : pct(ctx.futuresQuote.rate)}
                    </span>
                    <small className="pt-n">
                      베이시스 {ctx.futuresQuote.basis === null ? "-" : ctx.futuresQuote.basis.toFixed(2)}
                    </small>
                  </div>
                )}
              </div>
            )}

            {/*
              수급은 **투자자별 카드**다. 표로 두면 「코스피 외국인」을 찾으려고 가로세로를
              둘 다 훑어야 하는데, 카드면 **「외국인이 뭘 했나」가 한 장**에 모인다.
            */}
            {(ctx.investor || ctx.futures) && (
              <div className="jn-cards">
                {([
                  { k: "외국인", v: (x: { foreign: number; institution: number; individual: number }) => x.foreign },
                  { k: "기관", v: (x: { foreign: number; institution: number; individual: number }) => x.institution },
                  { k: "개인", v: (x: { foreign: number; institution: number; individual: number }) => x.individual },
                ] as const).map((col) => (
                  <div className="jn-card jn-card-flow" key={col.k}>
                    <em>{col.k} <i className="pt-n">억</i></em>
                    {ctx.investor && (
                      <>
                        <span className="jn-fl">
                          <i>코스피</i>
                          <b className={`num ${col.v(ctx.investor.kospi) > 0 ? "positive" : col.v(ctx.investor.kospi) < 0 ? "negative" : ""}`}>
                            {col.v(ctx.investor.kospi).toLocaleString("ko-KR")}
                          </b>
                        </span>
                        <span className="jn-fl">
                          <i>코스닥</i>
                          <b className={`num ${col.v(ctx.investor.kosdaq) > 0 ? "positive" : col.v(ctx.investor.kosdaq) < 0 ? "negative" : ""}`}>
                            {col.v(ctx.investor.kosdaq).toLocaleString("ko-KR")}
                          </b>
                        </span>
                      </>
                    )}
                    {ctx.futures && (
                      <span className="jn-fl">
                        <i>선물</i>
                        <b className={`num ${col.v(ctx.futures) > 0 ? "positive" : col.v(ctx.futures) < 0 ? "negative" : ""}`}>
                          {col.v(ctx.futures).toLocaleString("ko-KR")}
                        </b>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="jn-mkt-foot pt-n">
              {ctx.usRates && <span>미국 10년 {ctx.usRates.y10 ?? "-"} · 30년 {ctx.usRates.y30 ?? "-"}</span>}
              {ctx.overseas && (
                <span>
                  나스닥100선물 {ctx.overseas.nasdaqFut?.toLocaleString("ko-KR") ?? "-"}
                  {ctx.overseas.nasdaqFutRate !== null && ctx.overseas.nasdaqFutRate !== undefined ? ` (${pct(ctx.overseas.nasdaqFutRate)})` : ""}
                  {ctx.overseas.vkospi !== null && ctx.overseas.vkospi !== undefined ? ` · VKOSPI ${ctx.overseas.vkospi}` : ""}
                </span>
              )}
              {ctx.investor?.asOf && <span>수급 {ctx.investor.asOf} 기준</span>}
            </div>
          </div>
        )}

        {/*
          당일 매매현황 — **직접 적는다.**
          처음엔 모의투자에서 끌어왔는데 그건 시나리오를 짜 보는 자리고, 실제 매매는
          증권사 계좌에서 일어난다. 복기해야 하는 건 후자다.
          종목을 골라 주면 그 순간의 신호등은 기계가 붙인다 — 사람은 "왜"만 적으면 된다.
        */}
        {/*
          관망 — **안 사는 것도 판단이다.**

          노트가 매매를 전제로 짜여 있어서 쉰 날은 기록이 안 남았다. 그러면 나중에
          「위험할 때 쉬었나」를 셀 수가 없다. 시장이 어지러울 때는 쉰 날이 더 많고,
          그 판단이 성적을 가장 크게 가른다.
        */}
        <div className="jn-field">
          <span className="jn-label">오늘</span>
          <div className="filter-row">
            {([
              ["trade", "매매함"],
              ["watch", "관망 — 안 샀다"],
            ] as ["trade" | "watch", string][]).map(([k, label]) => (
              <button
                key={k}
                className={`filter-btn ${form.stance === k ? "active" : ""}`}
                onClick={() => setForm({ ...form, stance: form.stance === k ? null : k })}
              >
                {label}
              </button>
            ))}
          </div>
          {form.stance === "watch" && (
            <>
              <span className="jn-label">
                왜 쉬었나 <em className="jn-hint">이걸 세면 위험을 피한 건지 겁이 난 건지 갈립니다</em>
              </span>
              <div className="jn-tags">
                {(data?.watchTags ?? []).map((tag) => {
                  const on = (form.watchReasons ?? []).includes(tag.key);
                  return (
                    <button
                      key={tag.key}
                      className={`jn-tag ${on ? "on" : ""}`}
                      title={tag.hint}
                      onClick={() =>
                        setForm({
                          ...form,
                          watchReasons: on
                            ? (form.watchReasons ?? []).filter((x) => x !== tag.key)
                            : [...(form.watchReasons ?? []), tag.key],
                        })
                      }
                    >
                      {tag.label}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <div className="jn-field">
          <span className="jn-label">
            오늘의 매매{" "}
            <em className="jn-hint">
              실제 계좌에서 한 것을 적습니다 · 매수에는 <b>손절선</b>을 같이 —{" "}
              <b>R</b>(건 것 대비 얼마를 벌었나)이 거기서 나옵니다
            </em>
          </span>

          {/*
            **들고 있는 것부터** (2026-11-27 — 벤티지: "오늘의 매매에서는 기존에 가지고
            있던것도 보여줘야지 … 최종 평균단가랑 수량 볼 수 있게 해줘야지").

            오늘 적을 칸만 있으면 **오늘이 어제와 이어지지 않는다.** 「추가매수냐 신규냐」도
            「지금 몇 주를 들고 있나」도 안 보이는 채로 적게 된다. 아래 적는 칸의 내용이
            바로 이 줄에 반영된다 — 적자마자(저장하면) 평단·수량이 다시 계산된다.

            맨 아래 「내 매매」와 **같은 값**이다(`journalPositions`). 두 벌로 세지 않는다.
          */}
          {positions.filter((p) => p.holding || p.moveToday).length > 0 && (
            <div className="jn-hold">
              {positions
                .filter((p) => p.holding || p.moveToday)
                .map((p) => (
                  <div className={`jn-hold-row${p.holding ? "" : " done"}`} key={p.code}>
                    <b className="jn-hold-n">{p.name}</b>
                    {p.moveToday ? (
                      <span className={`jn-hold-m ${p.moveToday === "신규" || p.moveToday === "추가매수" ? "buy" : "sell"}`}>
                        {p.moveToday}
                      </span>
                    ) : (
                      <span className="jn-hold-m keep">보유</span>
                    )}
                    <span className="jn-hold-q pt-n">
                      평단 {p.base?.toLocaleString("ko-KR") ?? "-"}
                      {p.qty !== null ? ` · ${p.qty.toLocaleString("ko-KR")}주` : ""}
                      {p.basis && p.basis !== "매입가" ? ` · ${p.basis}` : ""}
                    </span>
                    <span className="jn-hold-l num">{p.last?.toLocaleString("ko-KR") ?? "-"}</span>
                    <span
                      className={`num jn-hold-c ${(p.change ?? 0) > 0 ? "positive" : (p.change ?? 0) < 0 ? "negative" : ""}`}
                    >
                      {p.change === null ? "-" : `${p.change > 0 ? "+" : ""}${p.change.toFixed(1)}%`}
                    </span>
                  </div>
                ))}
            </div>
          )}

          <div className="jn-trades">
            {(form.trades ?? []).map((t) => (
              <div className={`jn-trade ${t.kind}`} key={t.id}>
                <button
                  className={`jn-trade-kind ${t.kind}`}
                  onClick={() => patchTrade(t.id, { kind: t.kind === "buy" ? "sell" : "buy" })}
                  title="눌러서 매수/매도 전환"
                >
                  {t.kind === "buy" ? "매수" : "매도"}
                </button>
                <span className="jn-trade-name">{t.name || "종목 미지정"}</span>
                <input
                  className="pt-input short"
                  inputMode="numeric"
                  placeholder="단가"
                  value={t.price || ""}
                  onChange={(e) => patchTrade(t.id, { price: Number(e.target.value.replace(/,/g, "")) || 0 })}
                />
                <input
                  className="pt-input short"
                  inputMode="numeric"
                  placeholder="수량"
                  value={t.qty || ""}
                  onChange={(e) => patchTrade(t.id, { qty: Number(e.target.value.replace(/,/g, "")) || 0 })}
                />
                {t.level && (
                  <span className="jn-trade-sig">
                    <span className={`sig-dot ${t.level}`} /> {t.score}점
                  </span>
                )}
                {/* 기록 시점 수급 (2026-08-27) — 「누가 사고 있을 때 샀나」 자동 박제 */}
                {t.flow && (
                  <span className="jn-trade-sig" title="기록 시점의 당일 외인·기관 순매수 (억원)">
                    <i className={`num ${t.flow.foreign >= 0 ? "positive" : "negative"}`}>
                      외 {(t.flow.foreign / 100).toFixed(1)}
                    </i>
                    {" · "}
                    <i className={`num ${t.flow.inst >= 0 ? "positive" : "negative"}`}>
                      기 {(t.flow.inst / 100).toFixed(1)}
                    </i>
                  </span>
                )}
                <button className="row-del-btn" onClick={() => removeTrade(t.id)} title="삭제">
                  ✕
                </button>
                {/*
                  매매 메모도 같은 칸이다 (2026-11-25). 한 줄짜리 `input` 이라 길게 쓰면
                  **가로로 밀려** 앞부분이 안 보였다 — 스크린샷에서 "ㄹ 예상했다. 이 정도면
                  바닥이라고…" 처럼 머리가 잘려 있었다. 한 줄로 시작하되 길어지면 늘어난다.
                */}
                <AutoText
                  className="pt-input wide jn-note"
                  minRows={1}
                  placeholder={t.kind === "buy" ? "왜 샀나 — 한 줄" : "왜 팔았나 — 한 줄"}
                  value={t.note}
                  onChange={(e) => patchTrade(t.id, { note: e.target.value })}
                />
                {t.passed && t.passed.length > 0 && (
                  <span className="jn-trade-passed">기록 시점 통과 — {t.passed.join(" · ")}</span>
                )}
                {/*
                  근거 태그 — **매수에만** 묻는다. 「왜 팔았나」는 결과를 이미 아는 상태의
                  판단이라 성적으로 셀 수가 없다.
                  자유 서술은 위에 그대로 두고, 셀 수 있는 형태를 같이 받는다.
                */}
                {t.kind === "buy" && (
                  <span className="jn-trade-reasons">
                    {(data?.reasonTags ?? []).map((tag) => {
                      const on = (t.reasons ?? []).includes(tag.key);
                      return (
                        <button
                          key={tag.key}
                          className={`jn-tag ${on ? "on" : ""}`}
                          title={tag.hint}
                          onClick={() =>
                            patchTrade(t.id, {
                              reasons: on
                                ? (t.reasons ?? []).filter((x) => x !== tag.key)
                                : [...(t.reasons ?? []), tag.key],
                            })
                          }
                        >
                          {tag.label}
                        </button>
                      );
                    })}
                  </span>
                )}
                {/*
                  ── 포지션 노트 — **매수에만.**

                  이 노트는 「무엇을 볼까」까지는 잘 적어 왔는데 **「얼마나 잃을 각오인가」를
                  적을 자리가 없었다.** 어긴 규칙에 「손절 미이행」 태그만 있었는데, 손절선을
                  **미리** 적는 자리가 없으니 지켰는지 어겼는지도 결국 기억에 기대는 것이다.

                  세 칸이면 R 배수가 따라 나오고, 판 뒤에는 **근거 태그별 평균 R** 까지 나온다.
                  승률 70% 인데 평균 −0.3R 이면 지는 매매다 — 승률만으로는 그게 안 보인다.
                */}
                {t.kind === "buy" && (
                  <span className="jn-trade-plan">
                    <input
                      className="pt-input short"
                      inputMode="numeric"
                      placeholder="손절선"
                      title="이 아래로 가면 판다. R 배수의 분모입니다"
                      value={t.stop || ""}
                      onChange={(e) =>
                        patchTrade(t.id, { stop: Number(e.target.value.replace(/,/g, "")) || 0 })
                      }
                    />
                    <input
                      className="pt-input short"
                      inputMode="numeric"
                      placeholder="목표가"
                      value={t.target || ""}
                      onChange={(e) =>
                        patchTrade(t.id, { target: Number(e.target.value.replace(/,/g, "")) || 0 })
                      }
                    />
                    <input
                      className="pt-input short"
                      inputMode="decimal"
                      placeholder="위험 %"
                      title="이 매매에 건 금액이 계좌의 몇 %인가"
                      value={t.risk || ""}
                      onChange={(e) => patchTrade(t.id, { risk: Number(e.target.value) || 0 })}
                    />
                    <PlanReadout trade={t} />
                  </span>
                )}
              </div>
            ))}
          </div>

          <div className="jn-add">
            <div className="pt-search">
              <input
                className="pt-input"
                placeholder="종목 검색해서 추가"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                {...tradeKeys.inputProps}
              />
              {tradeCands.length > 0 && (
                <ul className="pt-results" role="listbox">
                  {tradeCands.map((r, i) => (
                    <li key={r.code}>
                      <button {...tradeKeys.itemProps(i)} onClick={() => addTrade(r)}>
                        {r.name} <span className="pt-n">{normalizeStockCode(r.code)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button className="filter-btn" onClick={() => addTrade(null)}>
              + 직접 입력
            </button>
          </div>
        </div>

        {/*
          **관심섹터·관심종목** (2026-11-25 — 벤티지 2023 블로그 목차의 「관심섹터 및 이유 /
          관심종목 및 이유」). 산 것만 적으면 **「봤는데 안 산 것」이 사라진다** — 나중에
          「그때 왜 안 샀나」를 물을 수 없다. 노트가 이미 쉰 날(`stance`)은 세고 있었는데,
          「무엇을 눈여겨봤나」는 빠져 있었다.

          자리가 「오늘 무엇을 했나」보다 **앞**인 것은 순서가 그렇기 때문이다 — 보고 나서 한다.
        */}
        <label className="jn-field">
          <span className="jn-label">
            오늘 본 섹터 <em className="jn-hint">산 것 말고 눈여겨본 것</em>
          </span>
          <AutoText
            className="jn-text"
            minRows={1}
            placeholder="예: 반도체 소부장 — 전공정이 먼저 가고 후공정이 따라오는 모양"
            value={form.watchSector ?? ""}
            onChange={(e) => setForm({ ...form, watchSector: e.target.value })}
          />
        </label>

        <label className="jn-field">
          <span className="jn-label">
            오늘 본 종목 <em className="jn-hint">안 샀어도 적는다 — 나중에 「왜 안 샀나」가 복기가 된다</em>
          </span>
          <AutoText
            className="jn-text"
            minRows={1}
            placeholder="예: 한화오션 — 수급은 좋은데 이미 3일 급등이라 걸렀다"
            value={form.watchStocks ?? ""}
            onChange={(e) => setForm({ ...form, watchStocks: e.target.value })}
          />
        </label>

        <label className="jn-field">
          <span className="jn-label">오늘 무엇을 했나</span>
          <AutoText
            className="jn-text"
            minRows={2}
            placeholder="샀다/팔았다/아무것도 안 했다 — 사실만"
            value={form.what ?? ""}
            onChange={(e) => setForm({ ...form, what: e.target.value })}
          />
        </label>

        <label className="jn-field">
          <span className="jn-label">왜 그렇게 판단했나</span>
          <AutoText
            className="jn-text"
            minRows={2}
            placeholder="그때 무엇을 보고 그렇게 생각했는지 — 나중에 이 문장이 맞았는지 본다"
            value={form.why ?? ""}
            onChange={(e) => setForm({ ...form, why: e.target.value })}
          />
        </label>

        {/*
          결과가 아니라 과정을 묻는다.
          규칙을 어겼는데 번 날이 제일 위험하다 — 그날 배운 게 다음에 크게 잃게 만든다.
        */}
        <div className="jn-field">
          <span className="jn-label">
            내 규칙대로 했나 <em className="jn-hint">벌었는지가 아니라 지켰는지</em>
          </span>
          <div className="filter-row" style={{ margin: 0 }}>
            {[
              { v: true, label: "지켰다" },
              { v: false, label: "어겼다" },
            ].map((o) => (
              <button
                key={String(o.v)}
                className={`filter-btn ${form.followedRules === o.v ? "active" : ""}`}
                onClick={() => setForm({ ...form, followedRules: o.v })}
              >
                {o.label}
              </button>
            ))}
            {form.followedRules === false && (
              <input
                className="pt-input wide"
                placeholder="어떤 규칙을 어겼나"
                value={form.brokenRule ?? ""}
                onChange={(e) => setForm({ ...form, brokenRule: e.target.value })}
              />
            )}
          </div>
        </div>

        <div className="jn-field">
          <span className="jn-label">
            오늘의 실수 <em className="jn-hint">없으면 안 골라도 됩니다</em>
          </span>
          <div className="jn-tags">
            {data.mistakeTags.map((t) => (
              <button
                key={t.key}
                className={`jn-tag ${(form.mistakes ?? []).includes(t.key) ? "on" : ""}`}
                onClick={() => toggleMistake(t.key)}
                title={t.hint}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="jn-field">
          <span className="jn-label">
            오늘의 상태 <em className="jn-hint">나중에 상태별 성적을 봅니다</em>
          </span>
          <div className="jn-tags">
            {data.moodTags.map((t) => (
              <button
                key={t.key}
                className={`jn-tag mood ${form.mood === t.key ? "on" : ""}`}
                onClick={() => setForm({ ...form, mood: form.mood === t.key ? "" : t.key })}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/*
          배운 것·내일 할 것은 **여러 줄** (2026-08-27) — 한 줄 입력이라 길게 적으면
          뒷부분이 칸 밖으로 밀려 안 보였다. 여기가 이 노트의 결론인데 정작 다시 읽을
          수가 없었던 셈이다.
        */}
        <label className="jn-field">
          <span className="jn-label">
            오늘 배운 것 <em className="jn-hint">이게 다음 달의 나를 바꿉니다</em>
          </span>
          <AutoText
            className="jn-text"
            minRows={3}
            placeholder="예: 시장 신호등이 빨간 날엔 정배열이어도 안 밀린 종목이 없었다"
            value={form.lesson ?? ""}
            onChange={(e) => setForm({ ...form, lesson: e.target.value })}
          />
        </label>

        {/*
          **전일 매매복기** (2026-11-25). 벤티지의 2023 블로그 목차에 있던 자리인데
          영문 템플릿 어디에도 없던 것이다 — **매수 순간의 판단은 다음 날에야 채점된다.**
          우리는 「예측」은 채점하면서 정작 실제 매매는 안 하고 있었다.

          채점은 기계가 한다(그날 적은 값 → 지금 값). 손절·목표를 적어 뒀으면 닿았는지까지.
          사람이 적을 것은 그걸 보고 드는 생각 한 줄뿐이다.
        */}
        {prevRev && prevRev.date && prevRev.rows.length > 0 && (
          <div className="jn-field">
            <span className="jn-label">
              전일 매매복기 <em className="jn-hint">{prevRev.date} 에 적은 매매가 지금 어떤가</em>
            </span>
            <div className="jn-prev">
              {prevRev.rows.map((r) => (
                <div className="jn-prev-row" key={`${r.kind}${r.code}${r.price}`}>
                  <em className={`jn-prev-k ${r.kind}`}>{r.kind === "buy" ? "매수" : "매도"}</em>
                  <b className="jn-prev-n">{r.name}</b>
                  {/*
                    **기준가를 보여 준다** (2026-11-27 — 벤티지: "전일 매매복기에 편입대비
                    등락률을 보여줘야 되지 않나 싶은데. 이것만 딸랑 보여주면 의미 없을 듯").

                    예전엔 `r.price`(사람이 적은 매입가)를 찍었다. 그런데 매입가를 안 적는
                    것이 기본값이라 **거기가 늘 「0」이었다.** 등락률을 재는 기준은 이미
                    서버가 고르고 있다(적은 매입가 → 적을 때 시세 → 그날 종가) — 화면도
                    그 값을 보여 줘야 앞뒤가 맞는다. 무엇으로 쟀는지(`basis`)도 같이 적는다.
                  */}
                  <span className="num jn-prev-p">
                    {r.basePrice !== null ? r.basePrice.toLocaleString("ko-KR") : "-"}
                    {r.now !== null ? ` → ${r.now.toLocaleString("ko-KR")}` : ""}
                    {r.basis && r.basis !== "매입가" && <small className="pt-n"> {r.basis}</small>}
                  </span>
                  {r.change === null ? (
                    <span className="pt-n jn-prev-c">지금 값 없음</span>
                  ) : (
                    <span className={`num jn-prev-c ${r.change > 0 ? "positive" : r.change < 0 ? "negative" : ""}`}>
                      {r.change > 0 ? "+" : ""}
                      {r.change.toFixed(1)}%
                      {/* 산 것이 올랐으면 잘한 것, **판 것이 올랐으면 아쉬운 것** — 방향이 반대다 */}
                      <small className="pt-n">{r.kind === "buy" ? (r.change > 0 ? " 들고 있었으면" : " 물렸다면") : r.change > 0 ? " 판 뒤 더 올랐다" : " 잘 팔았다"}</small>
                    </span>
                  )}
                  {(r.hitStop || r.hitTarget) && (
                    <span className={`jn-prev-hit ${r.hitStop ? "stop" : "target"}`}>{r.hitStop ? "손절선 닿음" : "목표가 닿음"}</span>
                  )}
                  {r.note && <span className="jn-prev-note pt-n">{r.note}</span>}
                </div>
              ))}
            </div>
            <AutoText
              className="jn-text"
              minRows={2}
              placeholder="어제 판단이 맞았나 — 틀렸으면 무엇을 잘못 봤나"
              value={form.prevReview ?? ""}
              onChange={(e) => setForm({ ...form, prevReview: e.target.value })}
            />
          </div>
        )}

        <label className="jn-field">
          <span className="jn-label">내일 할 것</span>
          <AutoText
            className="jn-text"
            minRows={3}
            placeholder="예: 개장 후 외국인이 전기전자 순매수 이어가는지 확인"
            value={form.tomorrow ?? ""}
            onChange={(e) => setForm({ ...form, tomorrow: e.target.value })}
          />
        </label>

        {/*
          **시스에게 복기 받기** — 업노트의 `[일일복기 프롬프트]` 를 버튼으로.
          보낼 거리가 있어야 뜻이 있으므로, 오늘 적은 게 아무것도 없으면 누르지 못하게 한다.
        */}
        <div className="jn-field">
          <span className="jn-label">
            시스 복기 <em className="jn-hint">오늘 적은 것 + 박제된 시장을 그대로 넘긴다</em>
          </span>
          <div className="filter-row" style={{ margin: 0 }}>
            <button
              className="filter-btn"
              disabled={aiBusy || !(form.what || form.why || (form.trades ?? []).length > 0)}
              onClick={() => {
                setAiBusy(true);
                setAiErr(null);
                void api
                  .sysAsk(buildReviewPrompt(form, ctx, prevRev, creed?.text ?? ""), { mode: "ai", noClarify: true })
                  .then((r) => {
                    /* `SysAnswer` 는 `{ pack, ai }` — 글은 `ai.text` 다. 없으면 안 덮는다 */
                    const text = r.ai?.text?.trim();
                    if (!text) {
                      setAiErr("시스가 답을 못 적었습니다 (AI 모드가 꺼져 있거나 키가 없을 수 있습니다)");
                      return;
                    }
                    setForm((f) => ({ ...f, aiReview: text, aiReviewAt: new Date().toISOString() }));
                  })
                  .catch((e: Error) => setAiErr(e.message))
                  .finally(() => setAiBusy(false));
              }}
            >
              {aiBusy ? "시스가 읽는 중…" : "시스에게 복기 받기"}
            </button>
            {form.aiReviewAt && <span className="pt-n">{new Date(form.aiReviewAt).toLocaleString("ko-KR")}</span>}
          </div>
          {aiErr && <div className="error-banner">{aiErr}</div>}
          {form.aiReview && <div className="jn-ai">{form.aiReview}</div>}
        </div>

        {/*
          **#매일읽기** — 벤티지의 업노트 맨 아래에 늘 붙어 있던 그것.
          가이드 메뉴로 빼 두면 안 읽는다. **복기하는 자리에서** 원칙을 다시 읽어야
          「오늘 이걸 지켰나」가 이어진다. 기본은 접어 둔다 — 매일 펼치는 건 네 몫이다.
        */}
        {creed && (
          <div className="jn-creed">
            <button className="jn-creed-h" onClick={() => setCreedOpen((v) => !v)}>
              {creedOpen ? "▾" : "▸"} <b>#매일읽기</b> <em className="pt-n">내 원칙 · 매수전략 · 매도전략</em>
            </button>
            {creedOpen && (
              <>
                {creedEdit === null ? (
                  <>
                    <pre className="jn-creed-body">{creed.text}</pre>
                    <button className="filter-btn" onClick={() => setCreedEdit(creed.text)}>
                      고치기
                    </button>
                  </>
                ) : (
                  <>
                    <AutoText className="jn-text" minRows={8} value={creedEdit} onChange={(e) => setCreedEdit(e.target.value)} />
                    <div className="filter-row" style={{ margin: 0 }}>
                      <button
                        className="filter-btn active"
                        onClick={() => {
                          const t = creedEdit;
                          void api
                            .journalCreedSave(t)
                            .then((c) => {
                              setCreed(c);
                              setCreedEdit(null);
                            })
                            .catch(() => undefined);
                        }}
                      >
                        저장
                      </button>
                      <button className="filter-btn" onClick={() => setCreedEdit(null)}>
                        취소
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/*
          예측 종목 (2026-08-27) — **판단만 걸린 것.**
          매매는 크기·타이밍이 섞여 성적이 판단력을 안 보여준다. 사지 않아도 예측은
          할 수 있고, 그 적중률이 「내가 시장을 읽는가」에 답한다.
          예측한 날 종가를 박제하고 다음 거래일 종가로 자동 채점된다.
        */}
        <div className="jn-field">
          <span className="jn-label">
            내일 예측{" "}
            <em className="jn-hint">
              다음 거래일 종가로 자동 채점됩니다 · 그날 시장 신호등·선물 수급도 함께 박제
            </em>
          </span>

          <div className="jn-picks">
            {(form.picks ?? []).map((p) => (
              <div className={`jn-pick ${p.dir}`} key={p.id}>
                <button
                  className={`jn-pick-dir ${p.dir}`}
                  onClick={() => patchPick(p.id, { dir: p.dir === "up" ? "down" : "up" })}
                  title="눌러서 오름/내림 전환"
                >
                  {p.dir === "up" ? "▲ 오를 것" : "▼ 내릴 것"}
                </button>
                <span className="jn-pick-name">{p.name}</span>
                {p.basePrice ? (
                  <span className="pt-n">{fmtNum(p.basePrice)}원</span>
                ) : (
                  <span className="pt-n">저장하면 기준가 박제</span>
                )}
                {p.result && (
                  <span className={`jn-pick-res ${p.result.hit ? "hit" : "miss"}`}>
                    {p.result.hit ? "적중" : "빗나감"} {p.result.rate > 0 ? "+" : ""}
                    {p.result.rate.toFixed(2)}%
                  </span>
                )}
                <input
                  className="pt-input wide"
                  placeholder="왜 그렇게 보나 — 한 줄"
                  value={p.note ?? ""}
                  onChange={(e) => patchPick(p.id, { note: e.target.value })}
                />
                <button className="row-del-btn" onClick={() => removePick(p.id)} title="삭제">
                  ✕
                </button>
              </div>
            ))}
          </div>

          <div className="jn-add">
            <div className="pt-search">
              <input
                className="pt-input"
                placeholder="예측할 종목 검색"
                value={pickQuery}
                onChange={(e) => setPickQuery(e.target.value)}
                {...pickKeys.inputProps}
              />
              {pickCands.length > 0 && (
                <ul className="pt-results" role="listbox">
                  {pickCands.map((r, i) => (
                    <li key={r.code}>
                      <button {...pickKeys.itemProps(i)} onClick={() => addPick(r)}>
                        {r.name} <span className="pt-n">{normalizeStockCode(r.code)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>

        {/*
          ✂ **오늘의 주문·체결은 걷어냈다** (2026-11-27 — 벤티지: "오늘의 주문 체결은
          없애줘. 메인 계좌에서 거래하는거라 의미 없을 듯").

          2026-09-10 에 붙인 칸이었다. 전제는 「주문 메뉴로 주문한다」였는데, 실제로는
          **메인 계좌에서 거래한다** — 그래서 여기엔 늘 「이날 주문 메뉴에서 나간 것이
          없습니다」만 떴다. 빈 칸은 그냥 빈 칸이 아니라 **화면을 읽는 눈을 한 번 더
          멈추게 한다.**

          서버 쪽(`/journal/orders`, `ordersOfDay`)과 저장본의 `orders` 는 **그대로 둔다** —
          주문 메뉴의 「복기 노트에 담기」가 쓰고, 지난 기록에도 이미 박혀 있다.
          화면에서만 뺀다.
        */}

        {/* 저장은 **맨 아래** (2026-08-27) — 다 적고 나서 손이 가는 자리가 여기다 */}
        <div className="jn-save-bar">
          <div className="jn-save-state">
            {dirty && !saving && <span className="jn-dirty">● 저장 안 된 편집이 있습니다</span>}
            {note && !dirty && <span className="jn-saved">✓ {note}</span>}
          </div>
          <button className="jn-save-btn" onClick={() => void save()} disabled={saving}>
            {saving ? "저장 중…" : entry ? "수정 저장" : "저장"}
          </button>
        </div>
      </section>

      {/* ── 쌓인 나 ── */}
      {/*
        예측 복기 (2026-08-27) — **내 판단이 맞는가.**
        매매 성적은 크기·타이밍이 섞여 판단력만 못 잰다. 예측은 그것만 잰다.
        시장 상태별·선물 수급별로 갈라 보는 게 이 표의 값어치다 —
        초록장에서만 맞으면 따라간 것이고, 어느 판에서나 맞으면 그게 실력이다.
      */}
      <PickReview picks={s.picks} onSelectStock={onSelectStock} />

      {/*
        판단 vs 실행 (2026-08-29) — 두 숫자를 나란히 놓아야 **고칠 자리**가 정해진다.
        예측은 맞는데 매매가 지면 문제는 보는 눈이 아니라 손이다(늦게 들어가거나
        일찍 판다). 반대면 방향을 잘못 보는 것이라 손볼 데가 전혀 다르다.
      */}
      {s.judgeVsAct && (
        <div className="jn-gap">
          <div className="jn-gap-side">
            <span className="jn-pick-big-k">판단 (예측 적중)</span>
            <b className={`jn-pick-big-v ${(s.judgeVsAct.pickHit ?? 0) >= 50 ? "positive" : "negative"}`}>
              {s.judgeVsAct.pickHit === null ? "—" : `${s.judgeVsAct.pickHit.toFixed(0)}%`}
            </b>
          </div>
          <span className="jn-gap-vs">vs</span>
          <div className="jn-gap-side">
            <span className="jn-pick-big-k">실행 (매매 승률)</span>
            <b className={`jn-pick-big-v ${(s.judgeVsAct.tradeWin ?? 0) >= 50 ? "positive" : "negative"}`}>
              {s.judgeVsAct.tradeWin === null ? "—" : `${s.judgeVsAct.tradeWin.toFixed(0)}%`}
            </b>
            <span className="pt-n">{s.judgeVsAct.tradeN}건 실현</span>
          </div>
          <p className="jn-gap-note">
            {s.judgeVsAct.pickHit !== null &&
            s.judgeVsAct.tradeWin !== null &&
            s.judgeVsAct.pickHit - s.judgeVsAct.tradeWin >= 15
              ? "방향은 맞히는데 매매가 못 따라갑니다 — 진입·청산 시점을 보세요(눈이 아니라 손의 문제)."
              : s.judgeVsAct.tradeWin !== null &&
                  s.judgeVsAct.pickHit !== null &&
                  s.judgeVsAct.tradeWin - s.judgeVsAct.pickHit >= 15
                ? "매매가 예측보다 낫습니다 — 실제로 살 때 더 신중하게 고르고 있다는 뜻입니다."
                : "판단과 실행이 비슷하게 갑니다."}
          </p>
        </div>
      )}

      <h3 className="section-heading">내 매매</h3>

      {/*
        **구간별 매매·수익 현황** (2026-11-27 — 벤티지: "밑에 내 매매 이거 의미가 뭐야?
        뭐라도 보여줘야 할 듯 아니면 5일간 매매 현황&수익현황. 10일 현황. 20일 현황 이렇게
        구간별로 볼 수 있게 해주던가").

        맞는 지적이었다. 이 아래는 전부 **쪼갠 통계**(근거 태그별·R·신호등 색별)라 표본이
        모일 때까지 「아직 없습니다」만 넉 줄 이어졌다 — 몇 달을 적어야 처음 말을 한다.
        그동안 비어 있을 자리가 아니다.

        그래서 **오늘 당장 답이 나오는 것**을 맨 위에 둔다. 요즘 얼마나 사고팔았나,
        판 것은 어땠나, 산 것은 지금 어떤가. 쪼개지 않았으니 첫 주부터 값이 나온다.

        ⚠️ **실현과 평가를 한 줄에 안 섞는다.** 판 것은 확정이고 든 것은 아직 아니다 —
        섞으면 「벌었다」가 둘 중 어느 쪽인지 사라진다.
      */}
      {windows.length > 0 && (
        <div className="jn-win">
          {windows.map((w) => (
            <div className="jn-win-card" key={w.days}>
              <div className="jn-win-h">
                최근 {w.days}일
                <em className="pt-n">{w.from} ~</em>
              </div>
              <div className="jn-win-l">
                <i>매매</i>
                <b>{w.traded}일</b>
                <i>관망</i>
                <b>{w.watched}일</b>
              </div>
              <div className="jn-win-l">
                <i>매수</i>
                <b>{w.buys}</b>
                <i>매도</i>
                <b>{w.sells}</b>
              </div>
              <div className="jn-win-r">
                <i>실현</i>
                {w.realized.n === 0 ? (
                  <b className="pt-n">판 것 없음</b>
                ) : (
                  <>
                    <b className={`num ${(w.realized.avg ?? 0) > 0 ? "positive" : (w.realized.avg ?? 0) < 0 ? "negative" : ""}`}>
                      {w.realized.avg === null ? "-" : `${w.realized.avg > 0 ? "+" : ""}${w.realized.avg.toFixed(1)}%`}
                    </b>
                    <small className="pt-n">
                      {w.realized.n}건
                      {w.realized.winRate !== null ? ` · ${w.realized.winRate.toFixed(0)}% 승` : ""}
                    </small>
                  </>
                )}
              </div>
              <div className="jn-win-r">
                <i>산 것 지금</i>
                {w.bought.n === 0 ? (
                  <b className="pt-n">산 것 없음</b>
                ) : (
                  <>
                    <b className={`num ${(w.bought.avg ?? 0) > 0 ? "positive" : (w.bought.avg ?? 0) < 0 ? "negative" : ""}`}>
                      {w.bought.avg === null ? "-" : `${w.bought.avg > 0 ? "+" : ""}${w.bought.avg.toFixed(1)}%`}
                    </b>
                    <small className="pt-n">{w.bought.n}건 · 아직 확정 아님</small>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/*
        **맨 위는 「내 매매가 어땠나」** (2026-11-25 — 벤티지: "구조가 너무 복잡하고 알아먹기
        힘들다. 최대한 빠르게 훑어서 알 수 있게 하자고. 미사여구 이런거 다 빼고 복기노트로
        인해 나의 매매가 어땠는지 알 수 있게 하는게 목표잖아").
        
        아래 통계는 **쪼갠 것**이라 표본이 모일 때까지 답을 못 준다. 그동안 가장 자주 묻는
        것은 「내가 뭘 들고 있고 그게 어떤가」다 — 그걸 맨 위 한 덩어리로 둔다.
        수량·매입가를 안 적어도 돌아간다(기준가가 없으면 적을 때 시세로 잰다).
      */}
      {positions.length > 0 && (
        <div className="jn-pos">
          {positions.map((p) => {
            const w = Math.min(100, Math.abs(p.change ?? 0) * 5);
            return (
              <div className={`jn-pos-row${p.holding ? " hold" : ""}`} key={p.code}>
                <b className="jn-pos-n">{p.name}</b>
                <span className="jn-pos-s">{p.holding ? "보유" : "정리"}</span>
                {p.moveToday && <span className="jn-pos-m">{p.moveToday}</span>}
                <span className="jn-pos-bar">
                  <i className={(p.change ?? 0) >= 0 ? "up" : "down"} style={{ width: `${w}%` }} />
                </span>
                <span className={`num jn-pos-c ${(p.change ?? 0) > 0 ? "positive" : (p.change ?? 0) < 0 ? "negative" : ""}`}>
                  {p.change === null ? "-" : `${p.change > 0 ? "+" : ""}${p.change.toFixed(1)}%`}
                </span>
                <span className="pt-n jn-pos-b">
                  {p.base?.toLocaleString("ko-KR") ?? "-"}
                  {p.last !== null ? ` → ${p.last.toLocaleString("ko-KR")}` : ""}
                  {p.basis && p.basis !== "매입가" ? ` · ${p.basis}` : ""}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {s.days === 0 ? (
        <div className="page-note">
          하루치는 반성이지만 <b>석 달치를 세면 내가 어떤 사람인지</b>가 나옵니다. 제일 자주 하는
          실수, 어떤 상태일 때 규칙을 어기는지, 규칙을 지킨 날과 어긴 날의 성적 차이가 여기
          쌓입니다. 오늘부터 적어 보세요.
        </div>
      ) : (
        <div className="jn-stats">
          {/*
            **무엇을 보고 산 것이 통했나.**

            이 표가 이 노트를 쓰는 이유다. 「신호등 보고 산 것」과 「수급 보고 산 것」 중
            어느 쪽이 나한테 통하는지는 몇 달 치를 세 봐야 안다.
            건수가 적으면 평균은 우연이라, 건수를 옆에 같이 적는다.
          */}
          {/*
            **내 매매는 대체로 몇 R 짜리인가.**

            승률·평균 수익률만 보면 「건 것 대비」가 안 보인다. 8% 를 걸고 번 3% 와
            1% 를 걸고 번 3% 는 전혀 다른 매매인데 둘 다 「+3%」로 적힌다.

            `count` 가 적으면 그건 성적이 나쁜 게 아니라 **손절선을 잘 안 적는다**는 뜻이다.
            그것도 알아야 하는 정보라 건수를 앞에 둔다.
          */}
          <div className="jn-stat-block wide">
            <div className="cost-sub">내 R — 건 것 대비 얼마를 벌었나</div>
            {s.rStat.count === 0 ? (
              <div className="jn-stat-note">
                아직 없습니다. 매수를 적을 때 <b>손절선</b>을 같이 적으면, 그 종목을 팔 때
                실현 R 이 여기 쌓입니다. <b>승률보다 R 이 진짜 성적</b>입니다 — 승률 70% 인데
                평균 −0.3R 이면 지는 매매입니다.
              </div>
            ) : (
              <div className="jn-edge">
                <div className="cost-row">
                  <span className="cost-name">평균 R</span>
                  <span
                    className={`num jn-edge-ret ${(s.rStat.avg ?? 0) >= 0 ? "positive" : "negative"}`}
                  >
                    {s.rStat.avg === null
                      ? "-"
                      : `${s.rStat.avg > 0 ? "+" : ""}${s.rStat.avg.toFixed(2)}R`}
                  </span>
                  {/* 아래 성적표들과 칸을 맞춘다 — 승률 자리는 여기 해당 값이 없다 */}
                  <span />
                  <span className="num jn-edge-win" title="가장 잘된 한 건">
                    {s.rStat.best === null ? "-" : `↑${s.rStat.best.toFixed(1)}R`}
                  </span>
                  <span className="num cost-usd">{s.rStat.count}건</span>
                </div>
                <div className="jn-stat-note">
                  최악 <b className="negative">{s.rStat.worst?.toFixed(1) ?? "-"}R</b> — 여기가
                  <b> −1R 보다 아래</b>면 손절선을 적어 놓고 안 지킨 것입니다.
                  손절선을 적은 매매만 셉니다.
                </div>
              </div>
            )}
          </div>

          <div className="jn-stat-block wide">
            <div className="cost-sub">무엇을 보고 산 것이 통했나</div>
            {s.reasonEdge.length === 0 ? (
              <div className="jn-stat-note">
                아직 셀 게 없습니다. 매수를 적을 때 <b>근거 태그</b>를 고르고, 그 종목을 팔면
                여기에 성적이 붙습니다 — <b>판 것만</b> 셉니다(물려 있는 걸 실패로 세면 안 됩니다).
              </div>
            ) : (
              <EdgeTable rows={s.reasonEdge} />
            )}
          </div>

          {/*
            **쪼갠 통계는 접는다** (2026-11-25). 신호등 색별·국면별은 표본이 모이기 전엔
            답을 못 주는데 자리는 늘 먹는다. 지우지 않고 접어 둔다 — 몇 달 뒤에 볼 것이다.
          */}
          <details className="jn-stat-block wide jn-fold">
            <summary>쪼개 보기 — 신호등 색별 · 시장 국면별</summary>
            <div className="cost-sub">살 때 신호등 색별</div>
            {s.signalEdge.length === 0 ? (
              <div className="jn-stat-note">아직 셀 게 없습니다.</div>
            ) : (
              <EdgeTable rows={s.signalEdge} />
            )}
            <div className="cost-sub" style={{ marginTop: 10 }}>
              시장 국면별
            </div>
            {s.marketEdge.length === 0 ? (
              <div className="jn-stat-note">아직 셀 게 없습니다.</div>
            ) : (
              <EdgeTable rows={s.marketEdge} />
            )}
          </details>

          {/*
            관망 — 쉰 날의 국면과 산 날의 국면을 견준다.
            쉰 날이 빨강에 몰려 있으면 위험을 피한 것이고, 초록에 몰려 있으면 겁이 난 것이다.
          */}
          <div className="jn-stat-block wide">
            <div className="cost-sub">
              관망 {s.watch.days}일 / 매매 {s.watch.tradeDays}일
            </div>
            <div className="jn-edge-two">
              <div>
                <div className="jn-stat-note">쉰 날의 시장</div>
                {s.watch.byMarket.length === 0 ? (
                  <div className="jn-stat-note">-</div>
                ) : (
                  s.watch.byMarket.map((m) => (
                    <div className="cost-row" key={m.key}>
                      <span className="cost-name">
                        <span className={`sig-dot ${m.key}`} /> {m.key}
                      </span>
                      <span className="num cost-usd">{m.count}일</span>
                    </div>
                  ))
                )}
              </div>
              <div>
                <div className="jn-stat-note">산 날의 시장</div>
                {s.watch.tradeByMarket.length === 0 ? (
                  <div className="jn-stat-note">-</div>
                ) : (
                  s.watch.tradeByMarket.map((m) => (
                    <div className="cost-row" key={m.key}>
                      <span className="cost-name">
                        <span className={`sig-dot ${m.key}`} /> {m.key}
                      </span>
                      <span className="num cost-usd">{m.count}일</span>
                    </div>
                  ))
                )}
              </div>
            </div>
            {s.watch.reasons.length > 0 && (
              <div className="jn-stat-note">
                쉰 이유 — {s.watch.reasons.slice(0, 5).map((r) => `${r.label} ${r.count}`).join(" · ")}
              </div>
            )}
            <div className="jn-stat-note">
              쉰 날이 <b>빨강·노랑</b>에 몰려 있으면 위험을 피한 것이고, <b>초록</b>에 몰려
              있으면 겁이 나서 못 산 것입니다 — 둘은 고쳐야 할 방향이 반대입니다.
            </div>
          </div>

          <div className="jn-stat-block">
            <div className="cost-sub">규칙 준수율</div>
            <div className="jn-big">{s.ruleRate === null ? "-" : `${s.ruleRate.toFixed(0)}%`}</div>
            <div className="jn-stat-note">
              지킨 날 {s.ruleEdge.keptDays}일 평균{" "}
              <b className={(s.ruleEdge.keptAvgReturn ?? 0) >= 0 ? "positive" : "negative"}>
                {pct(s.ruleEdge.keptAvgReturn)}
              </b>
              {" / "}어긴 날 {s.ruleEdge.brokeDays}일 평균{" "}
              <b className={(s.ruleEdge.brokeAvgReturn ?? 0) >= 0 ? "positive" : "negative"}>
                {pct(s.ruleEdge.brokeAvgReturn)}
              </b>
              <br />
              <span className="jn-warn">
                어긴 날 성적이 더 좋으면 그게 제일 위험한 신호입니다 — 그날 배운 게 다음에 크게
                잃게 만듭니다.
              </span>
            </div>
          </div>

          <div className="jn-stat-block">
            <div className="cost-sub">자주 하는 실수</div>
            {s.mistakes.length === 0 ? (
              <div className="jn-stat-note">아직 고른 실수가 없습니다.</div>
            ) : (
              s.mistakes.slice(0, 6).map((m) => (
                <div className="cost-row" key={m.key}>
                  <span className="cost-name">{m.label}</span>
                  <span className="cost-bar-wrap">
                    <span
                      className="cost-bar"
                      style={{ width: `${(m.count / s.mistakes[0].count) * 100}%` }}
                    />
                  </span>
                  <span className="num cost-usd">{m.count}회</span>
                </div>
              ))
            )}
          </div>

          <div className="jn-stat-block">
            <div className="cost-sub">상태별 규칙 준수율</div>
            {s.moods.length === 0 ? (
              <div className="jn-stat-note">아직 고른 상태가 없습니다.</div>
            ) : (
              s.moods.map((m) => (
                <div className="cost-row" key={m.key}>
                  <span className="cost-name">{m.label}</span>
                  <span className="cost-bar-wrap">
                    <span className="cost-bar alt" style={{ width: `${m.ruleRate ?? 0}%` }} />
                  </span>
                  <span className="num cost-usd">
                    {m.ruleRate === null ? "-" : `${m.ruleRate.toFixed(0)}%`}
                  </span>
                  <span className="num cost-calls">{m.count}일</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {s.lessons.length > 0 && (
        <>
          <h3 className="section-heading">배운 것 다시 읽기</h3>
          <div className="jn-lessons">
            {s.lessons.map((l) => (
              <div className="jn-lesson" key={l.date}>
                <span className="jn-lesson-date">{l.date.slice(5)}</span>
                <span>{l.lesson}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/*
        ── 내 판단 추적 ──
        「쌓인 나」 바로 뒤다. 위 통계가 **번 돈**을 세는 자리라면, 여기는
        **그 판단이 옳았나**를 세는 자리다 — 판 뒤에 오른 종목은 위쪽 어디에도 안 남는다.
      */}
      <TradeTrackPanel onSelectStock={onSelectStock} />

      {/* ── 지난 기록 ── */}
      {data.entries.length > 0 && (
        <>
          <h3 className="section-heading">지난 기록 {data.entries.length}일</h3>
          <div className="filter-row">
            {data.entries.slice(0, 30).map((e) => (
              <button
                key={e.date}
                className={`filter-btn ${date === e.date ? "active" : ""}`}
                onClick={() => setDate(e.date)}
                title={e.lesson || e.what}
              >
                {e.date.slice(5)}
                {e.followedRules === false && " ⚠"}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}


