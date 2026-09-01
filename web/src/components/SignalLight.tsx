import { useEffect, useState } from "react";
import { useSheetBack } from "../useSheetBack";
import { VerdictBar } from "./VerdictBar";
import { api, type SignalResult, type ThemeStrength } from "../api";
import { useMarketOpen } from "../useLive";
import { useTabActive } from "../tabActive";
import { ConstituentSheet, type ConstituentTarget } from "./overview/ConstituentSheet";

/**
 * 종목 신호등.
 *
 * 정배열·수급·이익·섹터·규모를 한 번에 판정해 초록/노랑/빨강으로 압축한다.
 * 종목명 옆에 붙여두면 목록을 훑으면서도 "볼 만한 종목인지"가 바로 걸러진다.
 *
 * 평가에 API 호출이 여러 번 들어가므로 서버가 15분 캐싱한다.
 * 목록에서는 배치 조회(useSignals)를 쓰고, 상세에서는 단건 조회를 쓴다.
 */

const LEVEL_LABEL: Record<string, string> = {
  green: "양호",
  yellow: "보통",
  red: "주의",
  unknown: "판단 불가",
};

/** 목록용 — 종목 여러 개를 한 번에 평가해서 코드별로 돌려준다 */
/** 한 번에 물어볼 종목 수 — 서버도 이만큼에서 자른다 */
const BATCH = 50;

export function useSignals(codes: string[]): Record<string, SignalResult> {
  const [map, setMap] = useState<Record<string, SignalResult>>({});
  /*
   * ⚠️ **정렬해서 잇는다** (2026-08-28, `useRealtime` 과 같은 이유).
   *
   * 결과는 종목코드로 찾으니 순서는 아무 뜻이 없다. 그런데 그냥 이으면 **순위가
   * 한 칸만 뒤바뀌어도 다른 문자열**이라 이 효과가 다시 돌고, 58종목이면 배치
   * 두 번이 통째로 다시 나간다. 시세분석은 순위를 10초마다 받으므로 —
   * 종목 구성은 그대로인데 — 10초마다 전부 다시 평가하고 있었다.
   * 신호등 점이 깜빡이고 서버가 바빠져 실시간 밀어주기까지 늦어진다.
   */
  const key = [...codes].sort().join(",");
  /*
   * 다시 매기는 **주기를 일부러 둔다** (2026-08-28).
   *
   * 정렬 전에는 순위가 뒤바뀔 때마다(=10초마다) 우연히 다시 돌고 있었다. 정렬로
   * 그 우연이 사라졌으니, 필요한 갱신은 **의도해서** 넣는다. 신호등에는 오늘 시세를
   * 보는 항목이 있어 하루 한 번으로는 모자라고, 10초는 과하다 — 3분.
   * 장이 닫혔거나 숨은 탭이면 돌지 않는다.
   */
  const marketOpen = useMarketOpen();
  const tabActive = useTabActive();
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!key || !marketOpen || !tabActive) return;
    const t = setInterval(() => setRound((n) => n + 1), 180_000);
    return () => clearInterval(t);
  }, [key, marketOpen, tabActive]);

  useEffect(() => {
    if (!key) return;
    void round; // 주기가 돌면 다시 받는다
    let cancelled = false;

    /*
     * ⚠️ **나눠서 부른다.**
     *
     * 서버가 한 번에 50 개까지만 받는다(종목마다 차트·수급·재무를 계산하므로 그 이상은
     * 키움 초당 5회 제한에 걸린다). 그런데 화면은 한 쪽에 100 줄을 그릴 수도 있어서,
     * 그냥 넘기면 **앞의 50 개만 켜지고 뒤는 영영 빈 채로 남았다** — 실제로 「40번째까지만
     * 가고 그 뒤엔 안 붙는다」는 말이 나왔다.
     *
     * 화면이 몇 줄을 보든 다 켜져야 한다. 50 개씩 잘라 **차례로** 부르고, 오는 대로
     * 화면에 얹는다 — 한꺼번에 보내면 서버가 막히고, 다 모아서 한 번에 그리면 그동안
     * 아무것도 안 보인다.
     */
    void (async () => {
      const all = key.split(",");
      for (let i = 0; i < all.length; i += BATCH) {
        if (cancelled) return;
        try {
          const r = await api.signalBatch(all.slice(i, i + BATCH));
          if (cancelled) return;
          setMap((prev) => ({ ...prev, ...r.results }));
        } catch {
          /* 한 묶음이 실패해도 나머지는 계속 받는다 */
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [key, round]);

  return map;
}

/** 점 하나짜리 배지 — 목록에서 종목명 옆에 */
export function SignalDot({ signal }: { signal?: SignalResult }) {
  if (!signal) return <span className="sig-dot loading" title="평가 중" />;
  /*
   * 서버 응답이 옛 모양이면 checks 가 배열이 아닐 수 있다 — 미니PC 가 아직 pull 안 한 경우다.
   * 배지 하나 때문에 화면 전체가 죽는 건 말이 안 된다.
   */
  const list = Array.isArray(signal.checks) ? signal.checks : [];
  const tip = `${LEVEL_LABEL[signal.level]} ${signal.score}점\n${list
    .map((c) => `${c.pass === null ? "?" : c.pass ? "O" : "X"} ${c.label} ${c.value}`)
    .join("\n")}`;
  return <span className={`sig-dot ${signal.level}`} title={tip} />;
}

/** 상세용 — 기준별 통과 여부를 펼쳐서 */
export function SignalPanel({
  code,
  onSelectStock,
}: {
  code: string;
  /** 섹터 구성종목에서 다른 종목으로 갈아타기 */
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [data, setData] = useState<SignalResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<ConstituentTarget | null>(null);
  /** 네이버 테마 고르기 — 한 종목이 여럿에 얽혀 있어 먼저 고르게 한다 */
  const [themePick, setThemePick] = useState(false);
  /** ETF 뒷배 고르기 — 상위 셋 중 어느 ETF 를 열지 */
  const [etfPick, setEtfPick] = useState(false);
  /* 뒤로가기로 고르개를 닫는다 (2026-08-28). 둘이 같이 열리진 않는다 */
  useSheetBack(themePick, () => setThemePick(false));
  useSheetBack(etfPick, () => setEtfPick(false));

  async function load(force = false) {
    setLoading(true);
    try {
      setData(await api.signal(code, force));
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  if (loading && !data) return <div className="empty">신호등 평가 중…</div>;
  if (!data) return null;

  return (
    <div className="sig-panel">
      <div className="sig-head">
        <span className={`sig-dot big ${data.level}`} />
        <span className="sig-level">{LEVEL_LABEL[data.level]}</span>
        <span className="sig-score">{data.score}점</span>
        {data.riskCapped && (
          <span className="sig-capped" title="추세·수급·실적은 초록이지만 위험 축이 빨강이라 노랑으로 낮췄습니다">
            위험으로 초록 차단
          </span>
        )}
        {/*
          **탈락** (2026-09-01) — 위험 차단과 다르다. 위험은 축 평균이 빨강일 때
          한 칸 낮추는 것이고, 탈락은 **기준 하나가 정해진 선을 넘으면 그것으로
          빨강**이다. 점수가 아무리 높아도 뒤집지 못한다.

          무엇 때문에 걸렸는지 반드시 적는다 — 「왜 빨강인지」를 모르면 사람이
          도구를 못 믿는다.
        */}
        {/*
          **지금 장세** (2026-09-01) — 자동 전환의 근거를 밝힌다.

          기준이 장세에 따라 켜지고 꺼지므로, 그걸 안 보여주면 「어제 초록이던
          종목이 오늘 노랑」인 이유를 알 수 없다. 무엇이 빠졌는지까지 적는다.
        */}
        {data.regime && (
          <span
            className={`sig-regime ${data.regime.kind}`}
            title={
              `전종목의 ${data.regime.breadth}% 가 20일선 위입니다 (50% 이상이면 강세장).
` +
              (data.regime.skipped.length > 0
                ? `이 장세에서 안 맞는 기준은 점수에서 뺐습니다 — ${data.regime.skipped.join(" · ")}`
                : "빠진 기준 없음") +
              `

같은 기준도 장세에 따라 방향이 뒤집힙니다 — 60일 신고가는 강세장 승률 +1.4%p, 약세장 -3.9%p 입니다.`
            }
          >
            {data.regime.kind === "bull" ? "▲" : "▼"} {data.regime.label} {data.regime.breadth}%
            {data.regime.skipped.length > 0 && ` · ${data.regime.skipped.length}개 뺌`}
          </span>
        )}
        {/*
          **덜 쟀다** (2026-09-01) — 이 도구에서 가장 크게 틀렸던 자리라 화면에 남긴다.

          렌즈가 없는 기준은 채점에서 빠지고 남은 것으로 평균이 난다. 그래서
          **덜 잰 종목이 더 쉽게 높은 점수를 받았다** — 실측에서 커버리지
          0.80~0.89 구간의 70점 통과가 중앙 -1.92·승률 -5.04 였다.

          점수를 안 내는 게 아니라 **초록만 막는다.** 못 재는 게 종목 잘못은
          아니므로 빨강으로 찍는 것도 거짓말이다.
        */}
        {data.lowCoverage && (
          <span
            className="sig-thin"
            title={
              `커버리지 = 켜 놓은 기준 중 몇 %나 실제로 재 봤나 (무게 기준).\n` +
              `이 종목은 ${Math.round((data.coverage ?? 0) * 100)}% 만 쟀습니다.\n\n` +
              (data.missing && data.missing.length > 0
                ? `못 잰 기준 — ${data.missing.join(" · ")}\n\n`
                : "") +
              `신호등은 못 잰 기준을 빼고 남은 것으로 평균을 냅니다. 그래서 덜 잰 종목은 남은 기준만 잘 맞으면 만점이 나옵니다 — 다 잰 종목은 다섯 군데를 다 통과해야 받는 점수를, 이 종목은 세 군데만 통과해도 받은 셈입니다.\n\n` +
              `실측에서 그렇게 덜 잰 관측의 70점 통과가 시장에 중앙 1.92%p 지고 승률이 5.04%p 낮았습니다. 그래서 초록만 막습니다 — 못 재는 게 종목 잘못은 아니니 점수와 빨강은 그대로 둡니다.`
            }
          >
            ◐ {Math.round((data.coverage ?? 0) * 100)}% 만 쟀음 — 초록 차단
          </span>
        )}
        {data.overHeated && (
          <span className="sig-thin" title="설정한 초록 상한을 넘어 노랑으로 낮췄습니다">
            ▲ 상한 초과 — 초록 차단
          </span>
        )}
        {/*
          **얇아서 막힘** (2026-09-01) — 벤티지: "거래대금 최소 100억 이상은
          되는 종목으로 해야지. 호가 슬리피지 나겠어."

          커버리지와 같은 방식이다 — 점수는 그대로 두고 초록만 막는다.
          「못 산다」와 「나쁘다」는 다른 말이라 빨강으로 찍으면 거짓이 된다.
        */}
        {data.tooThin && (
          <span
            className="sig-thin"
            title={
              `이 종목은 거래대금이 ${data.tradeEok?.toLocaleString("ko-KR")}억입니다.\n\n` +
              `얇은 종목은 내 주문에 호가가 밀립니다 — 화면에 +8%로 찍혀도 그 값을 못 받습니다.\n\n` +
              `게다가 거래가 거의 없으면 종가가 며칠씩 안 변해 수익률이 0으로 쌓이고, 그 0들이 검증 표본의 시장 기준선까지 끌어올립니다(실측: 문턱 없이 20일 중앙값 -5.36% → 10억 문턱에서 -11.23%).\n\n` +
              `점수와 빨강은 그대로 둡니다. 못 사는 것이 종목 잘못은 아니니까요. 문턱은 설정 > 신호등 기준에서 바꿉니다.`
            }
          >
            ▽ 거래대금 {data.tradeEok?.toLocaleString("ko-KR")}억 — 초록 차단
          </span>
        )}
        {data.vetoedBy && data.vetoedBy.length > 0 && (
          <span
            className="sig-vetoed"
            title="이 기준이 탈락선을 넘어 다른 점수와 무관하게 빨강입니다 — 실측에서 앞뒤 모두 손해였던 조건만 탈락으로 씁니다"
          >
            ✕ 탈락: {data.vetoedBy.join(" · ")}
          </span>
        )}
        <button className="filter-btn" onClick={() => load(true)} disabled={loading}>
          {loading ? "평가 중…" : "↻ 다시 평가"}
        </button>
      </div>

      {/*
        **이 점수가 무슨 뜻인가** (2026-09-01) — 점수 바로 아래.

        77점이 좋은 건지 나쁜 건지는 **실측에서 몇 점부터 값을 했나**를 알아야
        답할 수 있다. 그게 없으면 사람이 점수를 자기 감으로 해석하게 된다.
        값은 서버가 시뮬레이터로 낸 것을 읽는다 — 하드코딩하면 곧 거짓말이 된다.
      */}
      <VerdictBar score={data.score} />

      {/*
        축을 먼저 보여 준다. 한 숫자만 보면 「실적 좋고 수급 최악」과 그 반대가
        같은 점수로 보여 살 이유와 팔 이유가 상쇄된다.
        위험 축은 눈금 방향이 반대다 — 길수록 나쁘다.
      */}
      <div className="sig-axes">
        {/*
          `?? []` 를 지우지 마라. 서버가 아직 옛 코드로 돌고 있으면 `axes` 가 아예 없다 —
          웹만 새로 배포되고 서버가 재시작되지 않은 창(窓)이 실제로 있었다.
          그때 여기서 터지면 신호등 한 칸이 아니라 **화면 전체가 까매진다.**
          신호등은 종목발굴 맨 위 블록이라 페이지를 열자마자 그렇게 됐다.
        */}
        {(data.axes ?? []).map((a) => (
          <div className={`sig-axis ${a.level}`} key={a.key}>
            <div className="sig-axis-head">
              <span className="sig-axis-label">
                {a.label}
                {a.key === "risk" && <span className="pt-n"> (높을수록 위험)</span>}
              </span>
              <span className="sig-axis-score">{a.score === null ? "-" : `${a.score}점`}</span>
            </div>
            <div className="sig-axis-track">
              <span className="sig-axis-fill" style={{ width: `${a.score ?? 0}%` }} />
            </div>
          </div>
        ))}
      </div>

      <div className="sig-checks">
        {data.checks.map((c) => (
          <div className={`sig-check ${c.pass === null ? "na" : c.pass ? "ok" : "no"}`} key={c.key}>
            <span className="sig-mark">{c.pass === null ? "?" : c.pass ? "✓" : "✕"}</span>
            <span className="sig-label">
              {c.label}
              {/* 절반만 맞은 것을 표시한다. ✓ 하나로는 50점과 100점이 같아 보인다 */}
              {c.grade === 50 && <span className="sig-half"> 절반</span>}
            </span>
            {/*
              네이버 테마는 **한 종목이 여럿에 얽힌다** (삼성SDI 는 열 개).
              그래서 곧바로 구성종목으로 보내지 않고 **어느 테마인지 먼저 고르게** 한다 —
              가장 강한 하나만 보여 주면 나머지 아홉은 있는 줄도 모른다.
            */}
            {c.key === "naverTheme" && c.link ? (
              <button
                className="sig-value sig-link"
                onClick={() => setThemePick(true)}
                title="이 종목이 든 테마 전부 보기"
              >
                {c.value} ›
              </button>
            ) : c.key === "etfBacking" && (c.etfs?.length ?? 0) > 0 ? (
              /*
                ETF 뒷배도 누른다 (2026-08-28 — 「테마는 되는데 ETF 는 안 됐다」).
                상위 셋을 목록으로 펼치고, 하나를 고르면 그 ETF 가 종목으로 열린다.
              */
              <button
                className="sig-value sig-link"
                onClick={() => setEtfPick(true)}
                title="담고 있는 ETF 셋 보기 — 눌러서 각 ETF 열기"
              >
                {c.value} ›
              </button>
            ) : c.link ? (
              <button
                className="sig-value sig-link"
                onClick={() => setTarget(c.link!)}
                title={`${c.link.name} 구성종목 보기`}
              >
                {c.value} ›
              </button>
            ) : (
              <span className="sig-value">{c.value}</span>
            )}
            {c.weight > 1 && <span className="sig-weight">×{c.weight}</span>}
          </div>
        ))}
      </div>

      <div className="table-note">
        종합 점수는 <b>추세·수급·실적</b> 세 축의 평균입니다 — <b>위험은 섞지 않습니다.</b>{" "}
        위험이 빨강이면 나머지가 아무리 좋아도 초록을 주지 않습니다. 위험 항목(매물 부담·이격도·공매도·대차)은
        <b> 안전할 때 ✓</b>입니다. 기준과 가중치는 <b>설정 &gt; 신호등 기준</b>에서 바꿀 수 있고,
        데이터가 없어 판단할 수 없는 항목(?)은 점수 계산에서 빠집니다.
      </div>

      {themePick && (
        <ThemePickSheet
          code={code}
          onClose={() => setThemePick(false)}
          onPick={(key, name) => {
            setThemePick(false);
            setTarget({ kind: "theme", code: key, name });
          }}
        />
      )}

      {/* ETF 뒷배 목록 — 테마 픽커와 같은 문법. ETF 는 그 자체가 종목이라 바로 연다 */}
      {etfPick && (
        <div className="overlay" onClick={() => setEtfPick(false)}>
          <div className="sheet tpk-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-header">
              <h2>담고 있는 ETF</h2>
              <button className="close-btn" onClick={() => setEtfPick(false)}>
                ✕
              </button>
            </div>
            <div className="tpk-list">
              {(data.checks.find((c) => c.key === "etfBacking")?.etfs ?? []).map((e) => (
                <button
                  className="tpk-row"
                  key={e.code}
                  onClick={() => {
                    setEtfPick(false);
                    onSelectStock?.(e.code, e.name);
                  }}
                  title="이 ETF 를 종목으로 열기"
                >
                  <span className="tpk-name">{e.name}</span>
                  <b
                    className={`num ${(e.changeRate ?? 0) > 0 ? "positive" : (e.changeRate ?? 0) < 0 ? "negative" : ""}`}
                  >
                    {e.changeRate === null
                      ? "—"
                      : `${e.changeRate > 0 ? "+" : ""}${e.changeRate.toFixed(2)}%`}
                  </b>
                  <span className="pt-n tpk-sub">
                    이 종목 비중 {e.weight === null ? "?" : `${e.weight.toFixed(1)}%`}
                  </span>
                </button>
              ))}
            </div>
            <div className="table-note">
              단일종목·레버리지·지수(200/150)·커버드콜은 뺀, <b>테마로 담은 ETF</b> 상위
              셋입니다. 누르면 그 ETF 가 종목으로 열립니다 — 구성종목은 ETF 탭에서 보세요.
            </div>
          </div>
        </div>
      )}

      {target && (
        <ConstituentSheet
          target={target}
          onClose={() => setTarget(null)}
          onSelectStock={(c, n) => {
            setTarget(null);
            onSelectStock?.(c, n);
          }}
        />
      )}
    </div>
  );
}

/**
 * 이 종목이 든 **네이버 테마 전부** — 눌러서 하나를 고른다.
 *
 * 한 종목이 열 개 테마에 얽히는 일이 흔하다(삼성SDI: 2차전지 계열 넷·ESS·IT 대표주·
 * 전기차·리비안…). 신호등은 그중 **가장 강한 하나**로 점수를 매기는데, 그것만
 * 보여 주면 나머지가 있는 줄도 모른다. 강한 순으로 세워 두고 고르게 한다.
 *
 * 조회는 없다 — 서버의 테마 강도(파일 + 스냅샷)에서 이 종목이 든 것만 걸러 온다.
 */
function ThemePickSheet({
  code,
  onClose,
  onPick,
}: {
  code: string;
  onClose: () => void;
  onPick: (key: string, name: string) => void;
}) {
  const [rows, setRows] = useState<ThemeStrength[] | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .themeStrength("kr")
      .then((r) => {
        if (alive) setRows(r.themes.filter((t) => t.stocks.some((s) => s.code === code)));
      })
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, [code]);

  /* 뒤로가기로 닫힌다 (2026-08-28) */
  useSheetBack(true, onClose);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <h2>이 종목이 든 테마</h2>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        {rows === null ? (
          <div className="empty">불러오는 중…</div>
        ) : rows.length === 0 ? (
          <div className="page-note">네이버 테마에 편입된 곳이 없습니다.</div>
        ) : (
          <div className="tpk-list">
            {rows.map((t) => (
              <button className="tpk-row" key={t.key} onClick={() => onPick(t.key, t.name)}>
                <span className="tpk-name">{t.name}</span>
                <span className={`num ${t.changeRate >= 0 ? "positive" : "negative"}`}>
                  {t.changeRate > 0 ? "+" : ""}
                  {t.changeRate.toFixed(2)}%
                </span>
                <span className="pt-n tpk-sub">
                  {t.up}/{t.stocks.length}
                  {t.hit5.of > 0 && ` · ${t.hit5.of}일 중 ${t.hit5.n}일`}
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="table-note">
          강한 순입니다. 신호등 점수는 이 중 <b>가장 강한 테마</b>로 매깁니다.
        </div>
      </div>
    </div>
  );
}
