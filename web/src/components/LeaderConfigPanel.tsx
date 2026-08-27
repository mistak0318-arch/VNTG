import { useEffect, useState } from "react";
import { api, type LeaderConfig } from "../api";

/**
 * 주도주 탐색 기준 — **한 곳에서 정하고 두 곳에서 쓴다.**
 *
 * 이 숫자들이 정하는 것은 주도주 탐색 화면만이 아니다. **교차 신호**(주도주 태그 ∩
 * 슈퍼신호등)도 여기서 걸린 종목에서 나오고, 마켓 브리핑의 주도 섹터도 이 기준을 쓴다.
 * 그런데 조절하는 자리는 탐색 화면 안쪽 「조건」 버튼 뒤에만 있어서, 정작 결과를 보는
 * 사람은 **어디서 정해진 숫자인지** 찾지 못했다 (2026-08-27 지적: "기준 잡는 설정이
 * 흩어져 있는 것 같네").
 *
 * 이제 설정 > 분석 기준에도 같은 패널이 선다. 값은 서버 한 곳(`/api/pulse/leaders/config`)이라
 * 어디서 바꾸든 같은 값이 된다.
 */
export function LeaderConfigPanel() {
  const [cfg, setCfg] = useState<LeaderConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .leaderConfig()
      .then((c) => alive && setCfg(c))
      .catch((err: Error) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, []);

  function saveCfg(patch: Partial<LeaderConfig>) {
    if (!cfg) return;
    const next = { ...cfg, ...patch };
    // 화면을 먼저 바꾼다 — 서버 왕복을 기다리면 입력이 튄다
    setCfg(next);
    void api
      .leaderConfigSave(next)
      .then(setCfg)
      .catch(() => {
        /* 못 올려도 다음 저장에서 다시 올라간다 */
      });
  }

  if (error) return <div className="error-banner">{error}</div>;
  if (!cfg) return <div className="empty">기준 불러오는 중…</div>;

  return (
    <div className="st-cfg">
      <div className="st-cfg-row">
        <span className="st-cfg-k">최소 거래대금</span>
        <span>
          <input
            type="number"
            min={0}
            step={100}
            value={cfg.minTradeValue}
            onChange={(e) => saveCfg({ minTradeValue: Number(e.target.value) })}
          />{" "}
          억원 이상
        </span>
      </div>
      <div className="st-cfg-note">
        <b>이 문턱이 핵심</b>입니다. 대금이 얇은 구간은 작전·휩쏘가 끼기 쉬워서, 신호가 맞아도
        실제로 사고팔 수 있는 자리가 아닙니다.
      </div>

      <div className="st-cfg-row">
        <span className="st-cfg-k">모집단</span>
        <span>
          거래대금 상위{" "}
          <input
            type="number"
            min={20}
            max={400}
            step={20}
            value={cfg.universe}
            onChange={(e) => saveCfg({ universe: Number(e.target.value) })}
          />{" "}
          종목
        </span>
      </div>

      <div className="st-cfg-row">
        <span className="st-cfg-k">급등 기준</span>
        <span>
          당일{" "}
          <input
            type="number"
            min={0}
            max={30}
            step={1}
            value={cfg.surgeRate}
            onChange={(e) => saveCfg({ surgeRate: Number(e.target.value) })}
          />
          % 이상
        </span>
      </div>

      <div className="st-cfg-row">
        <span className="st-cfg-k">거래량 급증</span>
        <span>
          전일 대비{" "}
          <input
            type="number"
            min={1}
            max={20}
            step={0.5}
            value={cfg.volumeSpike}
            onChange={(e) => saveCfg({ volumeSpike: Number(e.target.value) })}
          />
          배 이상
        </span>
      </div>

      <div className="st-cfg-row">
        <span className="st-cfg-k">섹터 표시</span>
        <span>
          상위{" "}
          <input
            type="number"
            min={1}
            max={20}
            value={cfg.topSectors}
            onChange={(e) => saveCfg({ topSectors: Number(e.target.value) })}
          />
          개 · 최소{" "}
          <input
            type="number"
            min={1}
            max={10}
            value={cfg.minMembers}
            onChange={(e) => saveCfg({ minMembers: Number(e.target.value) })}
          />
          종목
        </span>
      </div>

      <div className="st-cfg-note">
        신고가·거래량급증·급등 중 <b>하나 이상</b>에 걸려야 주도주 목록에 듭니다 — 거래대금만
        큰 종목(늘 상위에 있는 대형주)이 목록을 채우지 않게 하려는 것입니다. 바꾸면{" "}
        <b>다음 훑기부터</b> 적용되고, <b>교차 신호</b>(신호등 찾기)도 같은 기준을 씁니다.
      </div>
    </div>
  );
}
