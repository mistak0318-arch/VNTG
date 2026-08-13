import { useEffect, useState } from "react";
import {
  api,
  fmtNum,
  normalizeStockCode,
  signClass,
  type GlobalQuote,
  type IndexCard,
  type MarketFlow,
  type SectorRow,
  type StockRow,
  type ThemeRow,
} from "../api";
import { SectorNews } from "../components/SectorNews";
import { RefreshBar } from "../components/RefreshBar";
import { useSection } from "../useSection";
import { WatchStar } from "../useWatchedCodes";

/**
 * 데일리 리포트 — 하루치 시황을 한 장으로 훑는 화면.
 *
 * 시황 대시보드가 "지금 이 순간"을 보는 화면이라면, 여기는 신문처럼 위에서 아래로
 * 읽어 내려가는 구조다. 나중에 이 조립 로직을 그대로 메일/텔레그램 본문으로 재사용한다.
 * 데이터는 전부 기존 시황 섹션 캐시를 쓰므로 추가 API 호출이 없다.
 */

type Edition = "morning" | "midday" | "closing";

const EDITIONS: { key: Edition; label: string; desc: string }[] = [
  { key: "morning", label: "조간", desc: "밤사이 해외 흐름과 오늘 볼 것" },
  { key: "midday", label: "장중", desc: "오전장 지수·테마·특징주" },
  { key: "closing", label: "석간", desc: "마감 시황과 수급 정리" },
];

function pct(v: number): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

/** 리포트 섹션 공통 껍데기 */
function Section({ no, title, children }: { no: number; title: string; children: React.ReactNode }) {
  return (
    <section className="report-section">
      <h3 className="report-heading">
        <span className="report-no">{no}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

/** 종목 여러 개를 한 줄씩 나열 */
function StockLines({
  rows,
  onSelectStock,
  limit = 10,
}: {
  rows: StockRow[];
  onSelectStock: (code: string, name: string) => void;
  limit?: number;
}) {
  if (rows.length === 0) return <div className="empty">데이터가 없습니다.</div>;
  return (
    <div className="report-lines">
      {rows.slice(0, limit).map((s, i) => {
        const code = normalizeStockCode(s.code);
        return (
          <button className="report-line" key={`${code}-${i}`} onClick={() => onSelectStock(code, s.name)}>
            <span className="rl-name">
              <WatchStar code={code} />
              {s.name}
            </span>
            <span className="rl-price">{fmtNum(s.price)}</span>
            <span className={`rl-rate ${signClass(s.changeRate)}`}>{pct(s.changeRate)}</span>
          </button>
        );
      })}
    </div>
  );
}

export function DailyReportPage({
  onSelectStock,
}: {
  onSelectStock: (code: string, name: string) => void;
}) {
  const [edition, setEdition] = useState<Edition>("closing");
  const [newsAt, setNewsAt] = useState<string>("");

  // 시황 대시보드와 같은 섹션 캐시를 공유한다 (추가 호출 없음)
  const indices = useSection<IndexCard[]>("indices", 60_000);
  const flow = useSection<MarketFlow>("flow", 60_000);
  const movers = useSection<{ rising: StockRow[]; falling: StockRow[] }>("movers", 60_000);
  const sectors = useSection<{ kospi: SectorRow[]; kosdaq: SectorRow[] }>("sectors", 180_000);
  const themes = useSection<{ top: ThemeRow[]; bottom: ThemeRow[] }>("themes", 180_000);
  const highLow = useSection<{ high: StockRow[]; low: StockRow[] }>("highLow", 300_000);
  const global = useSection<GlobalQuote[]>("global", 60_000);

  function reloadAll() {
    for (const s of [indices, flow, movers, sectors, themes, highLow, global]) s.refresh();
  }

  /** 리포트 전체의 "언제 기준" — 각 섹션 갱신시각 중 가장 오래된 것 */
  const stampMs = [indices.updatedAt, flow.updatedAt, themes.updatedAt, global.updatedAt]
    .filter((t): t is number => typeof t === "number");
  const oldest = stampMs.length > 0 ? Math.min(...stampMs) : null;
  const fmtStamp = (ms: number) =>
    new Date(ms).toLocaleString("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

  const today = new Date().toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  });

  const g = global.data ?? [];
  const idx = indices.data ?? [];
  const f = flow.data;
  const sec = sectors.data;
  const th = themes.data;

  return (
    <div className="report">
      <RefreshBar onRefresh={reloadAll} updatedAt={indices.updatedAt}>
        <div className="filter-row" style={{ margin: 0 }}>
          {EDITIONS.map((e) => (
            <button
              key={e.key}
              className={`filter-btn ${edition === e.key ? "active" : ""}`}
              onClick={() => setEdition(e.key)}
            >
              {e.label}
            </button>
          ))}
        </div>
      </RefreshBar>

      <header className="report-header">
        <h2>VNTG 데일리 리포트</h2>
        <div className="report-sub">
          {today} · {EDITIONS.find((e) => e.key === edition)?.label} —{" "}
          {EDITIONS.find((e) => e.key === edition)?.desc}
        </div>
        <div className="report-stamp">
          ⏱ 기준시각 <b>{oldest ? fmtStamp(oldest) : "불러오는 중"}</b>
          {newsAt && <> · 뉴스 <b>{fmtStamp(new Date(newsAt).getTime())}</b></>}
        </div>
      </header>

      {/* 1. 국내외 주요 지수 */}
      <Section no={1} title="국내외 주요 지수">
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th className="sticky-col">지수/종목</th>
                <th>현재가</th>
                <th>전일대비</th>
                <th>등락률</th>
              </tr>
            </thead>
            <tbody>
              {idx.map((c) => (
                <tr key={c.name}>
                  <td className="sticky-col">{c.name}</td>
                  <td>{fmtNum(c.price)}</td>
                  <td className={signClass(c.change)}>{fmtNum(c.change)}</td>
                  <td className={signClass(c.changeRate)}>{pct(c.changeRate)}</td>
                </tr>
              ))}
              {g.map((q) => (
                <tr key={q.key}>
                  <td className="sticky-col">
                    {q.label}
                    <span className="rl-sub"> {q.group}</span>
                  </td>
                  <td>{q.price === null ? "-" : fmtNum(q.price)}</td>
                  <td className={signClass(q.change)}>{q.change === null ? "-" : fmtNum(q.change)}</td>
                  <td className={signClass(q.changeRate)}>{q.changeRate === null ? "-" : pct(q.changeRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* 2. 투자자 수급 */}
      <Section no={2} title="투자자별 매매 동향">
        {f ? (
          <div className="summary-grid">
            {[
              { label: "외국인", value: f.kospi.foreign + f.kosdaq.foreign },
              { label: "기관", value: f.kospi.institution + f.kosdaq.institution },
              { label: "개인", value: f.kospi.individual + f.kosdaq.individual },
            ].map((it) => (
              <div className="summary-item" key={it.label}>
                <div className="label">{it.label}</div>
                <div className={`value ${signClass(it.value)}`}>
                  {it.value > 0 ? "+" : ""}
                  {fmtNum(it.value)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty">수급 데이터 불러오는 중...</div>
        )}
        <div className="table-note">단위: 억원 · 코스피/코스닥 합산</div>
      </Section>

      {/* 3. 특징 테마 */}
      <Section no={3} title="특징 테마 및 테마별 등락률">
        <div className="report-two-col">
          <div>
            <h4 className="report-subheading positive">상승 테마</h4>
            <div className="report-lines">
              {(th?.top ?? []).slice(0, 10).map((t) => (
                <div className="report-line static" key={t.code}>
                  <span className="rl-name">{t.name}</span>
                  <span className="rl-sub">{t.mainStock}</span>
                  <span className={`rl-rate ${signClass(t.changeRate)}`}>{pct(t.changeRate)}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <h4 className="report-subheading negative">하락 테마</h4>
            <div className="report-lines">
              {(th?.bottom ?? []).slice(0, 10).map((t) => (
                <div className="report-line static" key={t.code}>
                  <span className="rl-name">{t.name}</span>
                  <span className="rl-sub">{t.mainStock}</span>
                  <span className={`rl-rate ${signClass(t.changeRate)}`}>{pct(t.changeRate)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Section>

      {/* 4. 업종별 등락 */}
      <Section no={4} title="업종별 등락률">
        <div className="report-two-col">
          <div>
            <h4 className="report-subheading">코스피 상위</h4>
            <div className="report-lines">
              {(sec?.kospi ?? []).slice(0, 8).map((s) => (
                <div className="report-line static" key={s.code}>
                  <span className="rl-name">{s.name}</span>
                  <span className={`rl-rate ${signClass(s.changeRate)}`}>{pct(s.changeRate)}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <h4 className="report-subheading">코스닥 상위</h4>
            <div className="report-lines">
              {(sec?.kosdaq ?? []).slice(0, 8).map((s) => (
                <div className="report-line static" key={s.code}>
                  <span className="rl-name">{s.name}</span>
                  <span className={`rl-rate ${signClass(s.changeRate)}`}>{pct(s.changeRate)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Section>

      {/* 5. 특징 종목 */}
      <Section no={5} title="특징 종목 (급등/급락)">
        <div className="report-two-col">
          <div>
            <h4 className="report-subheading positive">상승률 상위</h4>
            <StockLines rows={movers.data?.rising ?? []} onSelectStock={onSelectStock} />
          </div>
          <div>
            <h4 className="report-subheading negative">하락률 상위</h4>
            <StockLines rows={movers.data?.falling ?? []} onSelectStock={onSelectStock} />
          </div>
        </div>
      </Section>

      {/* 6. 신고가/신저가 */}
      <Section no={6} title="52주(250일) 신고가 · 신저가">
        <div className="report-two-col">
          <div>
            <h4 className="report-subheading positive">신고가</h4>
            <StockLines rows={highLow.data?.high ?? []} onSelectStock={onSelectStock} limit={8} />
          </div>
          <div>
            <h4 className="report-subheading negative">신저가</h4>
            <StockLines rows={highLow.data?.low ?? []} onSelectStock={onSelectStock} limit={8} />
          </div>
        </div>
      </Section>

      {/* 7. 뉴스 클리핑 — 분야별 (뉴스·공시 탭과 같은 컴포넌트) */}
      <Section no={7} title="주요 뉴스 클리핑">
        <SectorNews perSector={8} onFetched={setNewsAt} />
      </Section>

      <div className="table-note report-footer">
        데이터: 키움 REST API · DART · 네이버 검색 API · Yahoo Finance ·
        시황 대시보드와 동일한 캐시를 사용하므로 추가 조회가 발생하지 않습니다
      </div>
    </div>
  );
}
