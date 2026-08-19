import { useCallback, useEffect, useState } from "react";
import { api, fmtNum, signClass, type ProgramRow } from "../api";
import { CollapsibleSection } from "../components/CollapsibleSection";
import { RefreshBar } from "../components/RefreshBar";
import { SortableTh, useSortableTable } from "../useSortableTable";

type Market = "kospi" | "kosdaq";
type Scope = "time" | "daily";

/** YYYYMMDDHHmmss 또는 HHmmss 를 보기 좋게 */
function fmtTime(t: string, scope: Scope): string {
  if (scope === "daily") {
    if (t.length >= 8) return `${t.slice(4, 6)}/${t.slice(6, 8)}`;
    return t;
  }
  if (t.length >= 6) return `${t.slice(0, 2)}:${t.slice(2, 4)}`;
  return t;
}

export function ProgramTradePage() {
  const [market, setMarket] = useState<Market>("kospi");
  const [scope, setScope] = useState<Scope>("daily");
  const [items, setItems] = useState<ProgramRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const sort = useSortableTable(items);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.programTrades(market, scope);
      setItems(res.items);
      setUpdatedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "알 수 없는 오류");
    } finally {
      setLoading(false);
    }
  }, [market, scope]);

  useEffect(() => {
    load();
  }, [load]);

  // 최근 값 요약 (일자별은 첫 행이 오늘, 값이 0이면 다음 행)
  const latest = items.find((r) => r.allBuy !== 0 || r.allSell !== 0) ?? null;

  return (
    <div>
      <CollapsibleSection title="프로그램 매매란? (차익 / 비차익 읽는 법)" defaultOpen={false}>
        <div className="card guide">
          <p>
            <b>프로그램 매매</b>는 사람이 한 종목씩 주문하는 게 아니라, 미리 짜둔 조건에 따라 여러 종목을
            한 바구니로 묶어 자동 주문하는 매매입니다. 주로 기관·외국인이 씁니다.
          </p>
          <p>
            <b>차익거래</b>는 선물과 현물의 가격 차이를 먹으려는 거래입니다. 선물이 현물보다 비싸지면 선물을
            팔고 현물을 사는 식이라, <b>방향성 베팅이 아니라 기계적인 가격차 정리</b>에 가깝습니다. 그래서
            차익 순매수가 늘어도 "시장을 좋게 본다"는 신호로 읽기는 어렵습니다. 만기일 근처엔 포지션 청산
            때문에 크게 출렁이기도 합니다.
          </p>
          <p>
            <b>비차익거래</b>는 선물과 무관하게 <b>주식 바스켓 자체를 사고파는</b> 거래입니다. 외국인·기관이
            "한국 주식 비중을 늘리자/줄이자"라고 결정하면 이 형태로 나갑니다. 그래서{" "}
            <b>비차익 순매수가 꾸준히 플러스면 실제 자금이 시장에 들어오고 있다는 뜻</b>으로 봅니다. 지수
            상승 국면에서 비차익이 같이 플러스면 상승에 힘이 실렸다고 해석하고, 반대로 지수는 오르는데
            비차익이 계속 마이너스면 매수 주체가 약하다는 경계 신호로 읽습니다.
          </p>
          <p className="guide-caution">
            주의: 하루치 수치만으로 판단하기보다 며칠 연속 방향을 보는 게 낫고, 선물 만기 주간(분기 마지막
            목요일 부근)엔 차익거래가 왜곡되니 비차익 위주로 보는 것이 안전합니다.
          </p>
        </div>
      </CollapsibleSection>

      <RefreshBar onRefresh={load} loading={loading} updatedAt={updatedAt} />

      <div className="filter-row">
        <button className={`filter-btn ${market === "kospi" ? "active" : ""}`} onClick={() => setMarket("kospi")}>
          코스피
        </button>
        <button className={`filter-btn ${market === "kosdaq" ? "active" : ""}`} onClick={() => setMarket("kosdaq")}>
          코스닥
        </button>
      </div>
      <div className="filter-row">
        <button className={`filter-btn ${scope === "daily" ? "active" : ""}`} onClick={() => setScope("daily")}>
          일자별
        </button>
        <button className={`filter-btn ${scope === "time" ? "active" : ""}`} onClick={() => setScope("time")}>
          시간대별 (당일)
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading && <div className="empty">불러오는 중...</div>}

      {!loading && !error && latest && (
        <section className="card">
          <h2>최근 수급 ({fmtTime(latest.time, scope)})</h2>
          <div className="summary-grid">
            <div className="summary-item">
              <div className="label">비차익 순매수</div>
              <div className={`value ${signClass(latest.nonArbNet)}`}>{fmtNum(latest.nonArbNet)}</div>
            </div>
            <div className="summary-item">
              <div className="label">차익 순매수</div>
              <div className={`value ${signClass(latest.arbNet)}`}>{fmtNum(latest.arbNet)}</div>
            </div>
            <div className="summary-item">
              <div className="label">전체 순매수</div>
              <div className={`value ${signClass(latest.allNet)}`}>{fmtNum(latest.allNet)}</div>
            </div>
            <div className="summary-item">
              <div className="label">해석</div>
              {/* px 를 박으면 설정의 글자 크기가 안 먹는다 */}
              <div className="value" style={{ fontSize: "0.8667rem" }}>
                {latest.nonArbNet > 0 ? "실매수 유입" : latest.nonArbNet < 0 ? "실매도 이탈" : "중립"}
              </div>
            </div>
          </div>
          <div className="table-note">단위: 백만원 · 비차익이 실제 자금 유입을 나타냅니다</div>
        </section>
      )}

      {!loading && !error && items.length === 0 && (
        <div className="page-note">
          데이터가 없습니다. 시간대별은 장중에만 값이 채워집니다 (현재 장 시작 전이면 일자별을 보세요).
        </div>
      )}

      {!loading && !error && items.length > 0 && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <SortableTh columnKey="time" label={scope === "daily" ? "일자" : "시간"} accessor={(r: ProgramRow) => r.time} sort={sort} className="sticky-col" />
                <SortableTh columnKey="arbBuy" label="차익매수" accessor={(r: ProgramRow) => r.arbBuy} sort={sort} />
                <SortableTh columnKey="arbSell" label="차익매도" accessor={(r: ProgramRow) => r.arbSell} sort={sort} />
                <SortableTh columnKey="arbNet" label="차익순매수" accessor={(r: ProgramRow) => r.arbNet} sort={sort} />
                <SortableTh columnKey="nonArbBuy" label="비차익매수" accessor={(r: ProgramRow) => r.nonArbBuy} sort={sort} />
                <SortableTh columnKey="nonArbSell" label="비차익매도" accessor={(r: ProgramRow) => r.nonArbSell} sort={sort} />
                <SortableTh columnKey="nonArbNet" label="비차익순매수" accessor={(r: ProgramRow) => r.nonArbNet} sort={sort} />
                <SortableTh columnKey="allNet" label="전체순매수" accessor={(r: ProgramRow) => r.allNet} sort={sort} />
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((r, i) => (
                <tr key={`${r.time}-${i}`}>
                  <td className="sticky-col">{fmtTime(r.time, scope)}</td>
                  <td>{fmtNum(r.arbBuy)}</td>
                  <td>{fmtNum(r.arbSell)}</td>
                  <td className={signClass(r.arbNet)}>{fmtNum(r.arbNet)}</td>
                  <td>{fmtNum(r.nonArbBuy)}</td>
                  <td>{fmtNum(r.nonArbSell)}</td>
                  <td className={`strong-col ${signClass(r.nonArbNet)}`}>{fmtNum(r.nonArbNet)}</td>
                  <td className={signClass(r.allNet)}>{fmtNum(r.allNet)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="table-note">단위: 백만원 · 순매수(+, 빨강) / 순매도(-, 파랑) · 비차익 열이 핵심</div>
        </div>
      )}
    </div>
  );
}
