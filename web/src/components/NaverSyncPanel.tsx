import { useEffect, useState } from "react";
import { api, type NaverSyncConfig } from "../api";

/**
 * 네이버에서 스스로 긁어오는 일들 (2026-08-30 요청 — 「지금 네이버에서 가져오는
 * 데이터는 뭐지? 동기화 목록을 설정에 넣고, 바로 실행도, 주기도, 끌 수도 있게」).
 *
 * ## 여기 없는 것도 네이버를 쓴다
 *
 * 이 목록은 **스스로 도는 일**만이다. 주요 뉴스 목록·본문, 장중 투자자 수급, 야간선물
 * 수급, 미국 종목 검색, ETF 정보는 **화면을 열 때 그때 한 번** 받아 온다. 끄고 켤 것이
 * 없어서(안 보면 안 받는다) 목록에 넣지 않았다 — 아래에 적어만 둔다.
 *
 * ## 「몇 분마다」가 없는 줄이 있는 이유
 *
 * 테마 DB·ETF 는 하루 중 정해진 시각에 도는 일이다. 장 마감 뒤에 한 번 받으면 되는
 * 것을 「10분마다」로 바꿔 놓으면 같은 것을 하루에 수십 번 받는다. 그래서 그런 줄에는
 * 주기 칸을 아예 안 만든다.
 */

const PERIOD_CHOICES: { min: number | null; label: string }[] = [
  { min: null, label: "자동" },
  { min: 1, label: "1분" },
  { min: 3, label: "3분" },
  { min: 5, label: "5분" },
  { min: 10, label: "10분" },
  { min: 30, label: "30분" },
  { min: 60, label: "1시간" },
];

function ago(iso?: string): string {
  if (!iso) return "아직 없음";
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

export function NaverSyncPanel() {
  const [cfg, setCfg] = useState<NaverSyncConfig | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api.naverSync().then(setCfg).catch(() => undefined);
  }, []);

  async function run(key: string, label: string) {
    setBusy(key);
    setMsg(`${label} 받는 중…`);
    try {
      const r = await api.naverSyncRun(key);
      setCfg(r.config);
      setMsg(`${label} — ${r.msg}`);
    } catch (err) {
      setMsg(`${label} 실패: ${err instanceof Error ? err.message : "알 수 없음"}`);
      api.naverSync().then(setCfg).catch(() => undefined);
    } finally {
      setBusy(null);
    }
  }

  if (!cfg) return <div className="table-note">불러오는 중…</div>;

  return (
    <div className="nsync">
      {cfg.jobs.map((j) => {
        const off = cfg.off.includes(j.key);
        const st = cfg.state[j.key];
        return (
          <div key={j.key} className={`nsync-row${off ? " off" : ""}`}>
            <div className="nsync-head">
              <b>{j.label}</b>
              <span className="nsync-when">{j.when}</span>
            </div>
            <div className="nsync-what">{j.what}</div>
            <div className="nsync-last">
              마지막: {ago(st?.at)}
              {st?.msg && (
                <span className={st.ok ? "nsync-ok" : "nsync-bad"}> · {st.msg}</span>
              )}
            </div>
            <div className="nsync-ctl">
              <button
                className={`filter-btn${off ? "" : " active"}`}
                onClick={async () => setCfg(await api.naverSyncEnable(j.key, off))}
              >
                {off ? "꺼짐" : "켜짐"}
              </button>
              {j.periodic && (
                <select
                  className="ma-input"
                  style={{ maxWidth: "6rem" }}
                  value={String(cfg.periodMin[j.key] ?? "")}
                  onChange={async (e) =>
                    setCfg(
                      await api.naverSyncPeriod(
                        j.key,
                        e.target.value === "" ? null : Number(e.target.value),
                      ),
                    )
                  }
                >
                  {PERIOD_CHOICES.map((p) => (
                    <option key={p.label} value={p.min === null ? "" : String(p.min)}>
                      {p.label}
                    </option>
                  ))}
                </select>
              )}
              <button
                className="filter-btn"
                disabled={busy !== null}
                onClick={() => run(j.key, j.label)}
              >
                {busy === j.key ? "받는 중…" : "지금 실행"}
              </button>
            </div>
          </div>
        );
      })}

      {msg && <div className="table-note">{msg}</div>}

      <div className="table-note">
        <b>꺼도 「지금 실행」은 됩니다.</b> 끈다는 건 「알아서 하지 마라」이지 「쓰지
        마라」가 아닙니다. 테마 DB 를 끄면 화면은 <b>마지막으로 받아 둔 것</b>을 계속
        보여 줍니다.
      </div>
      <div className="table-note">
        여기 없는 것도 네이버를 씁니다 — <b>주요 뉴스 목록·본문</b>, <b>장중 투자자
        수급</b>, <b>야간선물 수급</b>, <b>미국 종목 검색</b>, <b>ETF 정보</b>는 그 화면을
        열 때 그때 한 번 받습니다. 안 보면 안 받으니 끄고 켤 것이 없습니다.
      </div>
    </div>
  );
}
