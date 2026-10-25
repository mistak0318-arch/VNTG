import { useEffect, useState } from "react";
import { api, fmtNum, signClass, type IndexCard, type MarketFlow, type MarketSignal } from "../../api";

/**
 * **리포트 맨 위 한 장** (2026-10-25 — 벤티지: "지금 데일리 리포트 구조를 보다 더
 * 트레이더에게 도움될만한 구조로 변경해줘. 눈에 확 들어오지를 않아 / 인포그래픽이나
 * 다른 요소들 많이 활용해도 좋아").
 *
 * ## 왜 안 들어왔나
 *
 * 섹션이 **스물다섯 개**다. 일정 → 화제 → 복기 → 고정채널 → 야간선물 → 지수 → …
 * 순서로 평평하게 쌓여 있고, **결론이 없다.** 재료는 다 있는데 「그래서 오늘 어떤
 * 장인가」를 말해 주는 칸이 없으니, 매번 스물다섯 개를 읽어 스스로 종합해야 했다.
 *
 * ## 무엇을 맨 위에 두나
 *
 * 트레이더가 리포트를 여는 이유는 셋이고 순서가 있다 — 시스 신조의 ①체 ②추세 그대로다:
 *
 *   1. **지금 사도 되는 장인가**  → 판정 점수 + 지수
 *   2. **돈이 어디로 가나**        → 수급 막대 · 시장의 폭
 *   3. (아래 섹션들이 근거를 댄다)
 *
 * 그래서 이 카드는 **새 데이터를 거의 안 쓴다.** 지수·등락현황·수급은 리포트가 이미
 * 받아 놓은 것이고(`indices`·`flow`), 새로 부르는 것은 판정 하나다. 없던 정보를
 * 더하는 게 아니라 **있는 것을 맨 앞에 크게 세우는** 일이다.
 *
 * ## 인포그래픽은 「비율」에만 쓴다
 *
 * 숫자를 그림으로 바꾸면 **견줄 수 있을 때만** 이득이다. 수급은 세 주체의 크기와
 * 방향이 한눈에 보여야 하고(좌우 막대), 시장의 폭은 「상승 173 대 하락 719」보다
 * **길이 비율**이 빠르다. 반면 지수 등락률은 숫자가 이미 제일 빠르므로 그냥 크게 쓴다.
 */

/** 0~100 판정 점수를 띠로 — 색은 신호등과 같은 것을 쓴다 */
function VerdictBar({ score, level }: { score: number; level: MarketSignal["level"] }) {
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div className="rtc-gauge" role="img" aria-label={`판정 ${score}점`}>
      <div className={`rtc-gauge-fill ${level}`} style={{ width: `${pct}%` }} />
      {/* 눈금 — 빨강/노랑/초록이 갈리는 자리를 알아야 점수가 뜻을 갖는다 */}
      {[40, 70].map((t) => (
        <span className="rtc-gauge-tick" key={t} style={{ left: `${t}%` }} />
      ))}
    </div>
  );
}

/**
 * 수급 좌우 막대 — 0 을 가운데 두고 판 쪽은 왼쪽, 산 쪽은 오른쪽.
 *
 * ⚠️ 세 주체를 **같은 자로** 재야 한다. 각자 제 최대치로 그리면 「외국인 -1조」와
 * 「개인 +2,600억」이 같은 길이가 되어 거꾸로 읽힌다.
 */
function FlowBars({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return (
    <div className="rtc-flow">
      {rows.map((r) => {
        const w = (Math.abs(r.value) / max) * 50; // 한쪽 폭은 최대 50%
        const buy = r.value >= 0;
        return (
          <div className="rtc-flow-row" key={r.label}>
            <span className="rtc-flow-k">{r.label}</span>
            <div className="rtc-flow-track">
              <span className="rtc-flow-zero" />
              <span
                className={`rtc-flow-bar ${buy ? "buy" : "sell"}`}
                style={buy ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }}
              />
            </div>
            <b className={`rtc-flow-v ${signClass(r.value)}`}>{joEok(r.value)}</b>
          </div>
        );
      })}
    </div>
  );
}

/** 억 → 「1조 1,028억」. 서버 `aiSummary.joEok` 과 같은 규칙 (2026-10-23) */
function joEok(n: number): string {
  const sign = n < 0 ? "-" : "+";
  const a = Math.abs(Math.round(n));
  if (a >= 10_000) {
    const jo = Math.floor(a / 10_000);
    const rest = a % 10_000;
    return rest === 0 ? `${sign}${jo}조` : `${sign}${jo}조 ${rest.toLocaleString("ko-KR")}억`;
  }
  return `${sign}${a.toLocaleString("ko-KR")}억`;
}

/** 상승·보합·하락을 한 줄 띠로 — 「폭이 좁다」가 길이로 보인다 */
function BreadthBar({ up, flat, down }: { up: number; flat: number; down: number }) {
  const total = Math.max(1, up + flat + down);
  const w = (n: number) => `${(n / total) * 100}%`;
  return (
    <div className="rtc-breadth">
      <div className="rtc-breadth-track" role="img" aria-label={`상승 ${up} 보합 ${flat} 하락 ${down}`}>
        <span className="rtc-bd up" style={{ width: w(up) }} />
        <span className="rtc-bd flat" style={{ width: w(flat) }} />
        <span className="rtc-bd down" style={{ width: w(down) }} />
      </div>
      <div className="rtc-breadth-legend">
        <em className="up">상승 {fmtNum(up)}</em>
        <em className="flat">보합 {fmtNum(flat)}</em>
        <em className="down">하락 {fmtNum(down)}</em>
        <b className={up / total >= 0.5 ? "up" : "down"}>{Math.round((up / total) * 100)}%</b>
      </div>
    </div>
  );
}

export function ReportTopCard({
  indices,
  flow,
}: {
  /** 리포트가 이미 받아 둔 지수 카드 — 등락현황(상승·하락)이 여기 실려 온다 */
  indices: IndexCard[] | null;
  flow: MarketFlow | null;
}) {
  const [sig, setSig] = useState<MarketSignal | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .marketSignal()
      .then((r) => alive && setSig(r))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const kospi = indices?.find((c) => /코스피$|KOSPI$/i.test(c.name)) ?? indices?.[0] ?? null;
  const kosdaq = indices?.find((c) => /코스닥|KOSDAQ/i.test(c.name)) ?? null;
  /* 등락현황은 두 시장을 합쳐 본다 — 「시장의 폭」은 한 지수의 성질이 아니다 */
  const up = (kospi?.rising ?? 0) + (kosdaq?.rising ?? 0);
  const flat = (kospi?.flat ?? 0) + (kosdaq?.flat ?? 0);
  const down = (kospi?.falling ?? 0) + (kosdaq?.falling ?? 0);

  const kp = flow?.kospi;
  const flowRows = kp
    ? [
        { label: "외국인", value: kp.foreign },
        { label: "기관", value: kp.institution },
        { label: "개인", value: kp.individual },
      ]
    : [];

  if (!indices && !flow && !sig) return null;

  return (
    <div className="rtc">
      {/* ── 1층: 지금 어떤 장인가 ───────────────────────────── */}
      <div className="rtc-head">
        {sig && (
          <div className={`rtc-verdict ${sig.level}`}>
            <span className="rtc-dot" />
            <b className="rtc-level">
              {sig.level === "green" ? "초록" : sig.level === "yellow" ? "노랑" : sig.level === "red" ? "빨강" : "판정 불가"}
            </b>
            <span className="rtc-score">{sig.score}점</span>
          </div>
        )}
        <div className="rtc-idx">
          {[kospi, kosdaq].filter(Boolean).map((c) => (
            <span className="rtc-idx-one" key={c!.name}>
              <em>{c!.name}</em>
              <b className={signClass(c!.changeRate)}>
                {c!.changeRate > 0 ? "+" : ""}
                {c!.changeRate.toFixed(2)}%
              </b>
              <i>{fmtNum(c!.price)}</i>
            </span>
          ))}
        </div>
      </div>
      {sig && <VerdictBar score={sig.score} level={sig.level} />}
      {sig?.summary && <div className="rtc-summary">{sig.summary}</div>}

      {/* ── 2층: 돈이 어디로 가나 ───────────────────────────── */}
      <div className="rtc-grid">
        {flowRows.length > 0 && (
          <div className="rtc-box">
            <div className="rtc-box-h">코스피 수급</div>
            <FlowBars rows={flowRows} />
          </div>
        )}
        {up + down > 0 && (
          <div className="rtc-box">
            <div className="rtc-box-h">시장의 폭 — 몇이 같이 올랐나</div>
            <BreadthBar up={up} flat={flat} down={down} />
          </div>
        )}
      </div>
    </div>
  );
}
