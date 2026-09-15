import { useEffect, useState } from "react";
import { api, normalizeStockCode, type NpayRankRow } from "../../api";

/**
 * **네이버페이 이용자 랭킹** — 「수익률 상위 고객」 카드에 덧댄 두 번째 눈 (2026-09-16).
 *
 * 벤티지: "비슷한 거 있다고 제끼지 말고 융합해서 업그레이드."
 *
 * 카드 위쪽은 **키움 수익률 상위 고객**이다 — 실제로 돈을 잘 번 계좌들이 무엇을 순매수했나.
 * 여기는 **네이버페이 증권 이용자 전체**의 랭킹이다. 둘은 성격이 다르다:
 *
 *   · 키움 상위 고객 = **잘하는 소수**가 담은 것
 *   · 네이버페이     = **대중**이 담은 것 (수익률 상위 / 보유금액 상위, 연령대별)
 *
 * **겹치면 힘이 실리고, 어긋나면 한쪽이 늦은 것**이다. 대중 쪽에만 있는 종목은 쏠림을 의심한다.
 * 연령대를 나눠 보는 건 네이버만 되는 것 — 20대와 50대가 다른 종목을 들고 있으면 그것도 정보다.
 *
 * ⚠️ **`rankingValue` 는 안 찍는다.** 응답이 수익률인지 보유금액인지 단위를 말해 주지 않는다 —
 * 수익률 쪽은 `32302`(323%?), 보유금액 쪽은 `954613882`(9.5억? 전체 합이라기엔 작다). 곱해서 맞춰
 * 볼 기준이 없어 **검산이 안 되는 숫자**다(2026-09-15 데일리 리포트 100배 사고가 그 자리였다).
 * 순위 자체가 이미 정보라 **차례만 쓰고 값은 버린다.** 네이버가 단위를 밝히면 그때 붙인다.
 */

const AGES: { key: string; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "20", label: "20대" },
  { key: "30", label: "30대" },
  { key: "40", label: "40대" },
  { key: "50", label: "50대" },
  { key: "60", label: "60대+" },
];

export function NpayRankPanel({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [kind, setKind] = useState<"earningRate" | "assetAmount">("earningRate");
  const [age, setAge] = useState("all");
  const [rows, setRows] = useState<NpayRankRow[] | null>(null);
  const [day, setDay] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setRows(null);
    setError(null);
    api
      .naverNpayRank(kind, age)
      .then((r) => {
        if (!alive) return;
        setRows(r.rows);
        setDay(r.day);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [kind, age]);

  const anyMove = (rows ?? []).some((r) => (r.rate ?? 0) !== 0);

  return (
    <div className="npr">
      <div className="npr-head">
        <div className="ov-seg">
          <button type="button" className={kind === "earningRate" ? "on" : ""} onClick={() => setKind("earningRate")}>
            수익률 상위가 담은 것
          </button>
          <button type="button" className={kind === "assetAmount" ? "on" : ""} onClick={() => setKind("assetAmount")}>
            많이 담은 것
          </button>
        </div>
        <div className="npr-ages">
          {AGES.map((a) => (
            <button key={a.key} type="button" className={`npr-age${age === a.key ? " on" : ""}`} onClick={() => setAge(a.key)}>
              {a.label}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="table-note">네이버에서 못 받았습니다 — {error}</div>}
      {!error && !rows && <div className="table-note">불러오는 중…</div>}
      {rows && rows.length === 0 && <div className="table-note">이 연령대는 순위가 비어 있습니다.</div>}

      {/*
        장 전에는 네이버가 등락률을 0.0 으로 준다 — 그대로 찍으면 열다섯 줄이 모두 「0.00%」가 되어
        고장 난 화면처럼 보인다(글로벌 카드에서 겪은 그것). 다 0 이면 아예 안 그린다.
      */}
      {rows && rows.length > 0 && (
        <div className="npr-list">
          {rows.slice(0, 15).map((r) => {
            const jump = r.prevRank === null ? null : r.prevRank - r.rank;
            return (
              <button key={`${r.code}-${r.rank}`} type="button" className="npr-row" onClick={() => onSelectStock(normalizeStockCode(r.code), r.name)}>
                <b className="npr-rk">{r.rank}</b>
                <span className="npr-nm">{r.name}</span>
                {r.rate !== null && anyMove && (
                  <span className={`num npr-rt ${r.rate > 0 ? "up" : r.rate < 0 ? "down" : "flat"}`}>
                    {r.rate > 0 ? "+" : ""}
                    {r.rate.toFixed(2)}%
                  </span>
                )}
                <i className={`npr-jp${jump === null ? " new" : jump > 0 ? " up" : jump < 0 ? " down" : ""}`}>
                  {jump === null ? "신규" : jump > 0 ? `↑${jump}` : jump < 0 ? `↓${-jump}` : "–"}
                </i>
              </button>
            );
          })}
        </div>
      )}

      <div className="table-note">
        네이버페이 증권 이용자 {kind === "earningRate" ? <b>수익률 상위</b> : <b>보유금액 상위</b>} 기준
        {day && ` · ${day.slice(5).replace("-", "/")}`} · 위의 <b>키움 수익률 상위 고객</b>과 겹치는 종목이 있으면
        힘이 실린 자리입니다. 여기에만 있으면 대중 쏠림 쪽으로 봅니다. <b>참고 자료</b>입니다.
      </div>
    </div>
  );
}
