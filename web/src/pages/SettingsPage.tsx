import { useEffect, useState } from "react";
import { api, fmtNum, type ProviderUsage } from "../api";
import { RefreshBar } from "../components/RefreshBar";

interface KeyInfo {
  name: string;
  configured: boolean;
}

/** 사용률에 따라 색을 바꿔 한도 임박을 눈에 띄게 */
function rateColor(rate: number | null): string {
  if (rate === null) return "var(--muted)";
  if (rate >= 90) return "var(--red)";
  if (rate >= 70) return "#f5c542";
  return "var(--green)";
}

export function SettingsPage() {
  const [usage, setUsage] = useState<ProviderUsage[]>([]);
  const [day, setDay] = useState("");
  const [history, setHistory] = useState<{ day: string; counts: Record<string, number> }[]>([]);
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [isMock, setIsMock] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [u, h, k] = await Promise.all([api.apiUsage(), api.apiUsageHistory(14), api.apiKeys()]);
      setUsage(u.providers);
      setDay(u.day);
      setHistory(h.history);
      setKeys(k.keys);
      setIsMock(k.isMock);
    } catch (err) {
      setError(err instanceof Error ? err.message : "알 수 없는 오류");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div>
      <RefreshBar onRefresh={load} loading={loading} />

      {error && <div className="error-banner">{error}</div>}

      <section className="card">
        <h2>API 사용량 {day && `(${day})`}</h2>
        <div className="usage-grid">
          {usage.map((p) => (
            <div className="usage-card" key={p.provider}>
              <div className="usage-head">
                <span className="usage-label">{p.label}</span>
                <span className="usage-count num">
                  {fmtNum(p.total)}
                  {p.limit ? ` / ${fmtNum(p.limit)}` : ""}
                </span>
              </div>

              {p.limit !== null ? (
                <>
                  <div className="progress-bar">
                    <div
                      className="progress-bar-fill"
                      style={{
                        width: `${Math.min(p.usageRate ?? 0, 100)}%`,
                        background: rateColor(p.usageRate),
                      }}
                    />
                  </div>
                  <div className="usage-rate" style={{ color: rateColor(p.usageRate) }}>
                    {(p.usageRate ?? 0).toFixed(2)}% 사용
                  </div>
                </>
              ) : (
                <div className="usage-rate">일일 총량 제한 없음</div>
              )}

              {/* Claude는 호출 수가 아니라 토큰이 비용이므로 따로 강조해서 보여준다 */}
              {p.tokens && (
                <div className="token-box">
                  <div className="token-row">
                    <span>입력 토큰</span>
                    <span className="num">{fmtNum(p.tokens.input)}</span>
                  </div>
                  <div className="token-row">
                    <span>출력 토큰</span>
                    <span className="num">{fmtNum(p.tokens.output)}</span>
                  </div>
                  <div className="token-row cost">
                    <span>추정 비용</span>
                    <span className="num">${p.tokens.estimatedUsd.toFixed(4)}</span>
                  </div>
                </div>
              )}

              <div className="usage-stats">
                <span>성공 {fmtNum(p.ok)}</span>
                <span className={p.failed > 0 ? "negative" : ""}>실패 {fmtNum(p.failed)}</span>
                <span className={p.rateLimited > 0 ? "positive" : ""}>한도초과 {fmtNum(p.rateLimited)}</span>
              </div>

              <div className="usage-note">{p.note}</div>

              {p.topEndpoints.length > 0 && (
                <details className="usage-detail">
                  <summary>호출 내역 (상위 {p.topEndpoints.length})</summary>
                  <table className="data-table" style={{ width: "100%" }}>
                    <tbody>
                      {p.topEndpoints.map((e) => (
                        <tr key={e.endpoint}>
                          <td className="sticky-col" style={{ position: "static" }}>
                            {e.endpoint}
                          </td>
                          <td>{fmtNum(e.count)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </div>
          ))}
        </div>
      </section>

      {history.length > 0 && (
        <section className="card">
          <h2>최근 호출 추이</h2>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="sticky-col">일자</th>
                  <th>키움</th>
                  <th>DART</th>
                  <th>네이버</th>
                  <th>합계</th>
                </tr>
              </thead>
              <tbody>
                {[...history].reverse().map((h) => {
                  const total = (h.counts.kiwoom ?? 0) + (h.counts.dart ?? 0) + (h.counts.naver ?? 0);
                  return (
                    <tr key={h.day}>
                      <td className="sticky-col">{h.day.slice(5)}</td>
                      <td>{fmtNum(h.counts.kiwoom ?? 0)}</td>
                      <td>{fmtNum(h.counts.dart ?? 0)}</td>
                      <td>{fmtNum(h.counts.naver ?? 0)}</td>
                      <td className="strong-col">{fmtNum(total)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card">
        <h2>API 키 설정 상태</h2>
        <div className="key-list">
          {keys.map((k) => (
            <div className="key-row" key={k.name}>
              <span className="key-name">{k.name}</span>
              <span className={k.configured ? "key-ok" : "key-missing"}>
                {k.configured ? "설정됨" : "미설정"}
              </span>
            </div>
          ))}
          <div className="key-row">
            <span className="key-name">거래 모드</span>
            <span className={isMock ? "key-ok" : "key-missing"}>{isMock ? "모의투자" : "실전투자"}</span>
          </div>
        </div>
        <div className="table-note">
          키 값은 서버 밖으로 나가지 않습니다. 설정 여부만 표시합니다 · 값 변경은 server/.env 파일에서 직접
        </div>
      </section>
    </div>
  );
}
