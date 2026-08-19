import { useEffect, useState } from "react";
import { api, type SignalResult } from "../api";
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
export function useSignals(codes: string[]): Record<string, SignalResult> {
  const [map, setMap] = useState<Record<string, SignalResult>>({});
  const key = codes.join(",");

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    api
      .signalBatch(key.split(","))
      .then((r) => {
        if (!cancelled) setMap(r.results);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [key]);

  return map;
}

/** 점 하나짜리 배지 — 목록에서 종목명 옆에 */
export function SignalDot({ signal }: { signal?: SignalResult }) {
  if (!signal) return <span className="sig-dot loading" title="평가 중" />;
  const tip = `${LEVEL_LABEL[signal.level]} ${signal.score}점\n${signal.checks
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
        <button className="filter-btn" onClick={() => load(true)} disabled={loading}>
          {loading ? "평가 중…" : "↻ 다시 평가"}
        </button>
      </div>

      {/*
        축을 먼저 보여 준다. 한 숫자만 보면 「실적 좋고 수급 최악」과 그 반대가
        같은 점수로 보여 살 이유와 팔 이유가 상쇄된다.
        위험 축은 눈금 방향이 반대다 — 길수록 나쁘다.
      */}
      <div className="sig-axes">
        {data.axes.map((a) => (
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
            {c.link ? (
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
