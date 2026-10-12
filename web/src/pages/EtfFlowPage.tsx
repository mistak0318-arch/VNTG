import { useEffect, useState } from "react";
import type React from "react";
import { api, type EtfFlowGroup, type EtfFlowRow } from "../api";

/** 정렬할 수 있는 칸 — 숫자 칸 전부 */
type SortKey = "price" | "d1" | "d5" | "d20" | "volRatio" | "value5" | "todayValue";

/**
 * **국내 ETF 자금흐름** (2026-09-17 — ETF 분석 묶음). 해외판(ETF 자금흐름(해외))과 같은 모양의 국내판.
 * 지수·테마·미국(국내상장)·자산 대표 ETF 30여 개 — 1·5·20일 등락과 **거래대금 배수**(최근 5일 ÷ 그 앞 20일).
 * 대표는 서버가 이름 규칙으로 그때그때 고른다(코드 박아 두지 않음). 행을 누르면 그 ETF 상세.
 */
function pct(v: number | null): string {
  return v === null ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}
function cls(v: number | null): string {
  return v === null || v === 0 ? "" : v > 0 ? "up" : "down";
}
function eok(v: number | null): string {
  return v === null ? "-" : `${v.toLocaleString("ko-KR")}억`;
}

export function EtfFlowPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [rows, setRows] = useState<EtfFlowRow[] | null>(null);
  const [note, setNote] = useState("");
  const [asOf, setAsOf] = useState<"오늘" | "어제">("오늘");
  const [error, setError] = useState<string | null>(null);
  /*
   * **정렬은 머리 칸이 한다** (2026-10-12 — 벤티지: "표에서 누르면 정렬되게 하면 되지
   * 저렇게 놓을 필요가 있나?").
   *
   * 맞는 말이었다. 위에 있던 네모 넷은 **정렬 키일 뿐**인데 자리를 차지하면서 가격·5일
   * 평균·오늘로는 정렬도 못 했다. 표의 머리 칸은 이미 그 자리에 있고, 누르면 정렬되는
   * 것이 표의 관례다 — 없는 것을 새로 배우게 하지 않는다.
   */
  const [sortKey, setSortKey] = useState<SortKey>("volRatio");
  const [desc, setDesc] = useState(true);
  /** 마지막으로 받은 시각 (2026-09-18 전수검증 D11) — 서버 5분 캐시라 값은 그보다 옛것일 수 있다 */
  const [pulledAt, setPulledAt] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const pull = () =>
      api
        .etfFlow()
        .then((r) => {
          if (!alive) return;
          setRows(r.rows);
          setNote(r.note);
          setAsOf(r.asOf);
          setPulledAt(Date.now());
        })
        .catch((e: Error) => alive && setError(e.message));
    void pull();
    const t = window.setInterval(pull, 5 * 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  if (error) return <div className="page-note">ETF 자금흐름을 못 받았습니다 — {error}</div>;
  if (!rows) return <div className="page-note">불러오는 중… (처음엔 없는 일봉을 몇 개 받느라 10초쯤)</div>;

  const groups: EtfFlowGroup[] = ["지수", "테마·업종", "미국(국내상장)", "자산·채권", "그 밖에"];
  const sorted = (g: EtfFlowGroup) =>
    rows
      .filter((r) => r.group === g)
      .sort((a, b) => {
        /* 못 잰 값은 **늘 뒤로** — 오름차순으로 뒤집었다고 「모르는 것」이 1등이 되면 안 된다 */
        const av = a[sortKey];
        const bv = b[sortKey];
        if (av === null) return 1;
        if (bv === null) return -1;
        return desc ? bv - av : av - bv;
      });
  const hit = (k: SortKey) => () => {
    if (k === sortKey) setDesc((v) => !v);
    else {
      setSortKey(k);
      setDesc(true);
    }
  };
  const Th = ({ k, children, title }: { k: SortKey; children: React.ReactNode; title?: string }) => (
    <th className={`sortable-th${sortKey === k ? " active" : ""}`} onClick={hit(k)} title={title}>
      {children}
      <i>{sortKey === k ? (desc ? "▾" : "▴") : ""}</i>
    </th>
  );
  /* 한 줄 요약 — 배수가 제일 큰 테마와 20일 최고 */
  const hot = [...rows].filter((r) => r.volRatio !== null && r.group === "테마·업종").sort((a, b) => (b.volRatio ?? 0) - (a.volRatio ?? 0))[0];
  const best20 = [...rows].filter((r) => r.d20 !== null && r.group === "테마·업종").sort((a, b) => (b.d20 ?? 0) - (a.d20 ?? 0))[0];

  return (
    <div className="page">
      <p className="page-note">
        <b>돈이 어느 테마로 가나</b> — 대표 ETF 의 등락과 거래대금 배수(최근 5일 ÷ 그 앞 20일). 배수 <b>1.5 이상</b>이면 돈이 몰리는 중.
        {hot && best20 && (
          <>
            {" "}
            지금 돈이 제일 몰린 테마 <b>{hot.label}</b>({hot.volRatio?.toFixed(2)}배) · 20일 최고 <b>{best20.label}</b>({pct(best20.d20)})
          </>
        )}
      </p>
      {groups.map((g) => (
        <section className="card" key={g}>
          <h3>{g}</h3>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="sticky-col">대표</th>
                  <th>ETF</th>
                  <Th k="price">가격</Th>
                  <Th k="d1">{asOf === "오늘" ? "1일" : "어제"}</Th>
                  <Th k="d5">5일</Th>
                  <Th k="d20">20일</Th>
                  <Th k="volRatio" title="최근 5일 평균 거래대금 ÷ 그 앞 20일 평균 (어제까지)">
                    배수
                  </Th>
                  <Th k="value5">5일 평균</Th>
                  <Th k="todayValue">오늘</Th>
                </tr>
              </thead>
              <tbody>
                {sorted(g).map((r) => (
                  <tr key={r.code} className="clickable-row" onClick={() => onSelectStock(r.code, r.name)}>
                    <td className="sticky-col">
                      <b>{r.label}</b>
                    </td>
                    <td>
                      {r.name} <span className="pt-n">{r.code}</span>
                    </td>
                    <td className="num">{r.price.toLocaleString("ko-KR")}</td>
                    <td className={`num ${cls(r.d1)}`}>{pct(r.d1)}</td>
                    <td className={`num ${cls(r.d5)}`}>{pct(r.d5)}</td>
                    <td className={`num ${cls(r.d20)}`}>{pct(r.d20)}</td>
                    <td className={`num ${r.volRatio !== null && r.volRatio >= 1.5 ? "up" : ""}`}>{r.volRatio === null ? "-" : `${r.volRatio.toFixed(2)}배`}</td>
                    <td className="num">{eok(r.value5)}</td>
                    <td className="num">{eok(r.todayValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      <div className="table-note">
        {note}
        {pulledAt !== null && ` · ${new Date(pulledAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 기준 (5분마다 갱신)`}
      </div>
    </div>
  );
}
