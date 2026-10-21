import { useEffect, useState } from "react";
import { api, fmtNum, type KrOutlook } from "../api";

/**
 * **밸류에이션 띠** (2026-10-21 — 벤티지: "PER, PBR, 시가총액, 거래대금 이런 거 있잖아.
 * PER 이런 거 눈에 좀 잘 띄는 구조로 만들어줘봐. 그리고 포워드 PER도 … 하이닉스 PER이
 * 지금 27배 이게 맞아? 전수점검, 로직점검 해봐").
 *
 * ## 전수점검에서 나온 것
 *
 * 머리줄의 PER 은 키움 `ka10001` 의 `per` 이다. 그 값은 **오늘 주가 ÷ 직전 결산 EPS**
 * 였다. 하이닉스 10/21 로 확정했다 — 애프터 1,287,000 ÷ 2025년 결산 EPS 58,955 =
 * **21.83**, 화면값과 소수점까지 같다. PBR 도 ÷ 171,751 = **7.49** 로 같다.
 *
 * 계산은 한 번도 틀린 적이 없다. **분모가 작년 것**일 뿐이다. 그런데 지금은 10월이고
 * 하필 반도체 이익이 몇 배로 뛰는 중이라, 그 낡음이 값을 **3.8 배 비싸 보이게** 만든다:
 *
 *     SK하이닉스   작년 21.9  →  최근4분기 5.8  →  2026추정 3.7     3.80배
 *     삼성전자     작년 34.1  →  최근4분기 10.0 →  2026추정 4.9     3.40배
 *     HD현대중공업  작년 20.3  →  최근4분기 12.4                     1.63배
 *     카카오       작년 27.8  →  최근4분기 39.5                     0.71배  ← 거꾸로 **싸** 보인다
 *
 * 대형주 13 개 중 **7 개가 1.3 배 이상** 어긋났다. 늘 비싸 보이기만 하면 차라리 낫다 —
 * 카카오처럼 **싸 보이는** 쪽으로 틀리면 사게 만든다.
 *
 * ## 그래서 셋을 나란히 둔다
 *
 * 벤티지가 고른 모양이다. 하나만 남기면 「왜 어제까지 21.8 이던 게 5.7 이 됐나」를
 * 설명할 길이 없고, 무엇보다 **셋이 다 사실**이다 — 분모가 다를 뿐이다:
 *
 *     PER   작년 21.9   지금 5.74   추정 3.64
 *           2025.12     2026.06     2026.12E
 *
 * 왼쪽에서 오른쪽으로 **시간이 흐른다.** 그래서 줄어들면 이익이 느는 중이고 늘어나면
 * 주는 중이다 — 숫자 셋이 곧 방향이 된다. 맨 오른쪽에 그 방향을 한 마디로 적는다.
 *
 * ## 세 칸이 **같은 주가**를 쓴다
 *
 * ⚠️ 네이버가 주는 `per` 을 그대로 쓰면 안 된다. 그건 네이버가 제 스냅샷 가격으로 낸
 * 값인데 우리 쪽은 **6시간 캐시**라, 장중에 주가가 움직이면 작년 칸(키움, 실시간)만
 * 따라가고 나머지 둘이 멈춘다. 세 칸이 서로 다른 주가를 쓰면 비교가 거짓이 된다.
 *
 * 그래서 **EPS 만 받아 와서 지금 주가로 나눈다.** 하나의 주가, 세 개의 이익이다.
 * 네이버 per 은 EPS 가 없을 때의 대비책으로만 쓴다.
 */

/** 셋 중 한 칸 */
interface Col {
  key: string;
  label: string;
  when: string;
  per: number | null;
  pbr: number | null;
}

function fmtRatio(v: number | null): string {
  if (v === null || !Number.isFinite(v) || v <= 0) return "-";
  return v >= 100 ? v.toFixed(0) : v.toFixed(2);
}

/** 억원 → 조/억 */
function eok(n: number | null): string {
  if (n === null || !Number.isFinite(n) || n === 0) return "-";
  if (Math.abs(n) >= 10000) return `${(n / 10000).toLocaleString("ko-KR", { maximumFractionDigits: 0 })}조`;
  return `${Math.round(n).toLocaleString("ko-KR")}억`;
}

/**
 * 셋의 **방향**을 한 마디로.
 *
 * PER 이 내려가면 (같은 주가에) 이익이 느는 것이다. 숫자만 셋 늘어놓으면 어느 쪽이
 * 좋은 건지 매번 머리로 뒤집어야 한다 — 뒤집는 일은 여기서 한 번만 한다.
 *
 * ⚠️ **판단이 아니라 산수다.** 「싸다·비싸다」가 아니라 「이익이 느는 중·주는 중」이라고
 * 적는다. 싼지 비싼지는 업종과 국면이 정하는 것이지 이 세 숫자가 정하지 않는다.
 */
function drift(past: number | null, now: number | null, est: number | null): { text: string; cls: string } | null {
  const xs = [past, now, est].filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);
  if (xs.length < 2) return null;
  const first = xs[0];
  const last = xs[xs.length - 1];
  const r = last / first;
  if (r <= 0.6) return { text: "이익이 빠르게 느는 중", cls: "up" };
  if (r <= 0.85) return { text: "이익이 느는 중", cls: "up" };
  if (r >= 1.67) return { text: "이익이 빠르게 주는 중", cls: "down" };
  if (r >= 1.18) return { text: "이익이 주는 중", cls: "down" };
  return { text: "이익이 비슷하다", cls: "" };
}

export function ValuationStrip({
  code,
  price,
  info,
}: {
  code: string;
  /** 지금 주가 — 세 칸이 **모두** 이 값을 분자로 쓴다 */
  price: number;
  /** ka10001 — 작년 결산 EPS·BPS·시가총액이 여기 있다 */
  info: Record<string, unknown> | null;
}) {
  const [out, setOut] = useState<KrOutlook | null>(null);

  useEffect(() => {
    let alive = true;
    setOut(null);
    if (!code) return;
    api
      .naverOutlook(code)
      .then((r) => alive && setOut(r.outlook))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [code]);

  /*
   * ⚠️ **부호를 살린다.** 다른 자리에서 쓰는 `fmtAbsNum` 버릇으로 `Math.abs` 를 두면
   * 적자 EPS(-1,234) 가 양수가 되어 **멀쩡한 PER 이 찍힌다.** 적자 회사가 「PER 12 배」로
   * 보이는 것은 틀린 정도가 아니라 거꾸로다. 0 과 음수는 여기서 끊는다.
   */
  const n = (v: unknown): number | null => {
    const x = Number(String(v ?? "").replace(/[+,\s]/g, ""));
    return Number.isFinite(x) && x !== 0 ? x : null;
  };
  /** 주가 ÷ 이익. 이익이 0 이하면 PER 이란 게 없다 — 「-」 로 둔다 */
  const div = (eps: number | null): number | null => (eps !== null && eps > 0 && price > 0 ? price / eps : null);

  /* 작년 결산 — 키움이 주는 EPS·BPS. 못 받으면 키움의 per·pbr 을 그대로 쓴다 */
  const lastEps = n(info?.eps);
  const lastBps = n(info?.bps);
  const cols: Col[] = [
    {
      key: "past",
      label: "작년 결산",
      when: out?.last?.year ?? "",
      per: div(lastEps) ?? n(info?.per),
      pbr: div(lastBps) ?? n(info?.pbr),
    },
    {
      key: "now",
      label: "최근 4분기",
      when: out?.asOf ?? "",
      per: div(out?.eps ?? null) ?? out?.per ?? null,
      pbr: div(out?.bps ?? null) ?? out?.pbr ?? null,
    },
    {
      key: "est",
      label: "올해 추정",
      when: out?.est?.year ? `${out.est.year}E` : "",
      per: div(out?.estEps ?? null) ?? out?.estPer ?? null,
      pbr: null, // 추정 BPS 는 네이버 integration 에 없다 — 없는 칸은 비워 둔다
    },
  ];
  const hasAny = cols.some((c) => c.per !== null || c.pbr !== null);
  const mac = n(info?.mac);
  /*
   * ⚠️ **PER 이 없다고 띠를 통째로 접으면 안 된다.** 적자 회사는 PER 이 안 나오는데,
   * 띠를 지우면 **시가총액까지 같이 사라진다** — 머리줄에서 이리로 옮겨 왔으니 앱
   * 어디에도 안 남는다. 비율 줄만 접고 아랫줄은 남긴다.
   */
  if (!hasAny && mac === null) return null;
  /** 작년도 지금도 이익이 없다 = 적자. 「-」 셋보다 한 마디가 낫다 */
  const lossMaking = !hasAny && (lastEps !== null || out?.eps !== null);

  const way = drift(cols[0].per, cols[1].per, cols[2].per);
  const up = out?.targetMean && price > 0 ? ((out.targetMean - price) / price) * 100 : null;

  return (
    <div className="val-strip">
      {hasAny ? (
      <div className="val-grid">
        {/* 머리 — 칸마다 무슨 기준인지. 숫자 위에 있어야 숫자를 읽기 전에 읽는다 */}
        <span className="val-rowlab" />
        {cols.map((c) => (
          <span className="val-head" key={c.key}>
            {c.label}
            {c.when && <i>{c.when}</i>}
          </span>
        ))}
        <span className="val-note">
          {way && <em className={way.cls}>{way.text}</em>}
        </span>

        <span className="val-rowlab" title="주가 ÷ 주당순이익. 분모가 어느 기간의 이익이냐에 따라 값이 크게 달라집니다">
          PER
        </span>
        {cols.map((c) => (
          <span className={`val-v${c.key === "now" ? " lead" : ""}`} key={c.key}>
            {fmtRatio(c.per)}
            {c.per !== null && <u>배</u>}
          </span>
        ))}
        <span className="val-note" />

        <span className="val-rowlab" title="주가 ÷ 주당순자산. 1 보다 낮으면 장부가 아래">
          PBR
        </span>
        {cols.map((c) => (
          <span className={`val-v${c.key === "now" ? " lead" : ""}`} key={c.key}>
            {c.key === "est" ? <em className="val-none">추정 없음</em> : fmtRatio(c.pbr)}
            {c.key !== "est" && c.pbr !== null && <u>배</u>}
          </span>
        ))}
        <span className="val-note" />
      </div>
      ) : (
        <div className="val-loss">
          {lossMaking ? "적자라 PER·PBR 이 나오지 않습니다" : "PER·PBR 자료가 없습니다"}
        </div>
      )}

      {/* 아랫줄 — 띠 하나로 「얼마짜리 회사인가」가 끝나야 한다 */}
      <div className="val-foot">
        <span>
          시가총액 <b>{eok(mac)}</b>
        </span>
        {out?.dividendYield !== null && out?.dividendYield !== undefined && out.dividendYield > 0 && (
          <span title="주당배당금 ÷ 주가">
            배당수익률 <b>{out.dividendYield.toFixed(2)}%</b>
          </span>
        )}
        {out?.targetMean && (
          <span title={`증권사 목표주가 평균${out.consensusDate ? ` · ${out.consensusDate}` : ""}`}>
            목표주가 <b>{fmtNum(out.targetMean)}</b>
            {up !== null && (
              <i className={up > 0 ? "up" : up < 0 ? "down" : ""}>
                {" "}
                {up > 0 ? "+" : ""}
                {up.toFixed(0)}%
              </i>
            )}
          </span>
        )}
        <span className="val-src">
          작년=키움 · 최근4분기·추정=네이버 컨센{out?.consensusDate ? ` ${out.consensusDate.slice(5)}` : ""}
        </span>
      </div>
    </div>
  );
}
