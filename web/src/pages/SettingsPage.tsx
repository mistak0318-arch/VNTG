import { useEffect, useState } from "react";
import { FONTS, FONT_SCALES, useAppearance } from "../useAppearance";
import { api, fmtNum, type ProviderUsage } from "../api";
import { RefreshBar } from "../components/RefreshBar";
import { AlertConfigPanel } from "../components/AlertConfigPanel";
import { ChannelCollectPanel } from "../components/ChannelCollectPanel";
import { SignalConfigPanel } from "../components/SignalConfigPanel";

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
  const appearance = useAppearance();

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
      <section className="card">
        <h2>구독 채널 수집 (텔레그램)</h2>
        <p className="page-note">
          내가 구독 중인 텔레그램 채널을 읽어서 <b>여러 채널이 동시에 말하고 있는 것</b>을
          뽑아냅니다. 채널 하나가 떠드는 건 노이즈지만, 열 개가 같은 종목을 말하면 신호입니다.
        </p>
        <ChannelCollectPanel />
      </section>

      <section className="card">
        <h2>관심종목 시그널 (텔레그램)</h2>
        <p className="page-note">
          장중에 관심종목이 조건에 걸리면 텔레그램 시그널 방으로 알립니다.
          알림은 많아지면 무시하게 되므로, 기준값을 올려 <b>덜 울리게</b> 맞추는 게 요령입니다.
        </p>
        <AlertConfigPanel />
      </section>

      <section className="card">
        <h2>신호등 기준</h2>
        <p className="page-note">
          종목명 옆 신호등이 어떤 기준으로 켜지는지 정합니다. 내 매매 기준을 여기에 적어두고,
          맞지 않으면 계속 고쳐가면서 쓰는 것이 이 기능의 목적입니다.
        </p>
        <SignalConfigPanel />
      </section>

      <section className="card">
        <h2>화면 설정</h2>

        <div className="appearance-row">
          <span className="appearance-label">테마</span>
          <div className="filter-row" style={{ margin: 0 }}>
            {([
              { key: "dark" as const, label: "다크" },
              { key: "light" as const, label: "라이트" },
            ]).map((t) => (
              <button
                key={t.key}
                className={`filter-btn ${appearance.theme === t.key ? "active" : ""}`}
                onClick={() => appearance.set({ theme: t.key })}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="appearance-row">
          <span className="appearance-label">글꼴</span>
          <select
            className="group-select"
            style={{ maxWidth: 180 }}
            value={appearance.font}
            onChange={(e) => appearance.set({ font: e.target.value as typeof appearance.font })}
          >
            {FONTS.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </div>

        <div className="appearance-row">
          <span className="appearance-label">글자 크기</span>
          <div className="filter-row" style={{ margin: 0 }}>
            {FONT_SCALES.map((sc) => (
              <button
                key={sc}
                className={`filter-btn ${appearance.fontScale === sc ? "active" : ""}`}
                onClick={() => appearance.set({ fontScale: sc })}
              >
                {sc}%
              </button>
            ))}
          </div>
        </div>

        <div className="font-preview">
          미리보기 — 삼성전자 <span className="num positive">+6.68%</span> / SK하이닉스{" "}
          <span className="num negative">-1.23%</span> · 거래대금 <span className="num">6,282</span>억
        </div>
        <div className="table-note">이 설정은 이 기기(브라우저)에만 저장됩니다.</div>
      </section>

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
