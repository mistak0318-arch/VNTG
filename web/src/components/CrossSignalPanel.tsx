import { useEffect, useState } from "react";
import { api, signClass, type MarketPulse } from "../api";

/**
 * 교차 신호 — **두 목록이 동시에 가리키는 종목.**
 *
 * 주도주 탐색이 붙인 태그(신고가·거래량급증·급등)와 🌟 슈퍼신호등 목록의 교집합이다.
 * 각자 딴 화면에 있어서 같은 종목이 둘 다에 걸려도 사람이 오가며 눈으로 맞춰야 했다 —
 * 그 교집합이 가장 강한 자리인데 아무도 안 세고 있었다.
 *
 * 원래 시장 흐름 분석에 있었는데 **신호등 찾기로 옮겼다** (2026-08-27):
 * 「지금 판이 어떤가」와 「어느 종목을 볼까」는 다른 물음이고, 이건 뒤쪽이다.
 *
 * 값은 시장 맥박(`marketPulse`)이 이미 계산해 준다 — 여기서 다시 세지 않는다.
 * 서버 쪽 교차 계산은 5분 캐시라 탭을 여닫아도 조회가 늘지 않는다.
 */
export function CrossSignalPanel({
  onSelectStock,
}: {
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [pulse, setPulse] = useState<MarketPulse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .pulse()
      .then((p) => alive && setPulse(p))
      .catch((err: Error) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (!pulse) return <div className="empty">교차 신호 불러오는 중…</div>;

  const cross = pulse.cross;
  if (!cross) return <div className="page-note">교차 신호를 낼 수 없었습니다.</div>;

  return (
    <section className="card">
      <h2>교차 신호 — 두 목록이 동시에 가리키는 종목</h2>
      <p className="page-note">
        <b>주도주 태그</b>(신고가·거래량급증·급등)와 <b>🌟 슈퍼신호등</b>에 동시에 걸린
        종목입니다. 업종 자금(최근 5일 외인+기관)까지 들어오고 있으면 「업종유입」이 붙습니다.
        걸린 종목은 관심 그룹 <b>「슈퍼신호등+교차」</b>에 자동으로 담깁니다 — 그 뒤로 어떻게
        갔는지 따라갈 수 있어야 하기 때문입니다.
      </p>
      {cross.stocks.length === 0 ? (
        <div className="page-note">{cross.note}</div>
      ) : (
        <>
          <div className="mp-cross-note">{cross.note}</div>
          <div className="mp-cross">
            {cross.stocks.map((s) => (
              <button className="mp-cross-item" key={s.code} onClick={() => onSelectStock?.(s.code, s.name)}>
                <b>{s.name}</b>
                <span className={`num ${signClass(s.changeRate)}`}>
                  {s.changeRate > 0 ? "+" : ""}
                  {s.changeRate.toFixed(2)}%
                </span>
                <span className="mp-cross-tags">
                  {s.tags.join(" · ")}
                  {s.sectorInflow && " · 업종유입"}
                </span>
                {s.sector && <span className="pt-n">{s.sector}</span>}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="table-note">
        <b>기준</b> — 거래대금 상위 200위 안에서 최소 거래대금(기본 500억)을 넘고, 신고가·
        거래량급증(전일 2배)·급등(+5%) 중 **하나 이상**에 걸린 종목이 「주도주」입니다. 그중
        슈퍼신호등에도 든 종목만 여기 남습니다(최대 8개). 숫자는 <b>설정 &gt; 분석 기준</b>에서
        바꿉니다. 마켓 브리핑의 「오늘의 이벤트」는 <b>다른 기준</b>입니다 — 그쪽은 실제로 발송된
        알림(키워드·시그널·손절·체결강도)과 VI·공시의 기록이라, 스캐너 판정과는 무관합니다.
      </div>
    </section>
  );
}
