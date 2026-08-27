import { useEffect, useState } from "react";
import { api, type ThemeDbSummary } from "../api";

/**
 * 테마 DB 받기 — 설정 > 분석 기준.
 *
 * 평소엔 스케줄러가 알아서 받는다(국내 주 1회 · 미국 매일 07시). 이 패널은
 * **지금 당장 받고 싶을 때**와 **언제 받은 것인지 확인할 때** 쓴다.
 *
 * 국내는 10분쯤 걸린다 — 테마마다 페이지 한 장이라 273장이다. 그래서 시작만 시키고
 * 진행률을 따로 물어본다. 응답을 붙들고 기다리면 브라우저가 먼저 끊는다.
 */
export function ThemeDbPanel() {
  const [sum, setSum] = useState<ThemeDbSummary | null>(null);
  const [prog, setProg] = useState<{ done: number; total: number; at: string; running: boolean } | null>(
    null,
  );
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => {
    api
      .naverThemeSummary()
      .then(setSum)
      .catch(() => undefined);
  };

  useEffect(() => {
    load();
    /* 받는 중일 때만 진행률을 물어본다 — 평소엔 조용하다 */
    const t = setInterval(() => {
      api
        .naverThemeProgress()
        .then((p) => {
          setProg(p.running ? p : null);
          if (!p.running && prog) load(); // 방금 끝났으면 요약을 새로
        })
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const when = (iso: string) =>
    iso ? new Date(iso).toLocaleString("ko-KR", { hour12: false }) : "받은 적 없음";

  async function run(kind: "kr" | "us") {
    setMsg(null);
    try {
      if (kind === "kr") await api.naverThemeFetch();
      else await api.naverThemeFetchUs();
      setMsg(kind === "kr" ? "국내 테마를 받기 시작했습니다 (10분쯤 걸립니다)" : "미국 테마를 받기 시작했습니다 (2분쯤)");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "시작하지 못했습니다");
    }
  }

  return (
    <div>
      <p className="page-note">
        테마 <b>분류와 편입 사유</b>를 네이버에서 받아 둡니다. 등락률·상승비율·연속성은
        여기 저장하지 않고 <b>매일 우리가 계산</b>하므로, 이 데이터가 며칠 낡아도 화면의
        숫자는 늘 오늘 것입니다.
      </p>

      <div className="tdp-rows">
        <div className="tdp-row">
          <span className="tdp-k">국내</span>
          <span className="tdp-v">
            {sum ? `테마 ${sum.themes}개 · 종목 ${sum.stocks}개` : "…"}
            {sum && sum.withDesc > 0 && (
              <em className="pt-n"> · 편입 사유 {sum.withDesc}개</em>
            )}
          </span>
          <span className="pt-n tdp-when">{sum ? when(sum.fetchedAt) : ""}</span>
          <button className="filter-btn" onClick={() => void run("kr")} disabled={Boolean(prog)}>
            지금 받기
          </button>
        </div>

        <div className="tdp-row">
          <span className="tdp-k">미국</span>
          <span className="tdp-v">
            {sum ? `테마 ${sum.usThemes}개 · 종목 ${sum.usStocks}개` : "…"}
          </span>
          <span className="pt-n tdp-when">{sum ? when(sum.usFetchedAt) : ""}</span>
          <button className="filter-btn" onClick={() => void run("us")} disabled={Boolean(prog)}>
            지금 받기
          </button>
        </div>
      </div>

      {prog && (
        <div className="tdp-prog">
          받는 중 — {prog.done}/{prog.total} {prog.at && `· ${prog.at}`}
        </div>
      )}
      {msg && <div className="alert-note">{msg}</div>}

      <div className="table-note">
        <b>국내</b>는 주 1회(일요일 04시), <b>미국</b>은 매일 07시에 자동으로 받습니다.
        국내는 분류만 받고 시세는 키움에서 나오지만, 미국은 <b>같은 응답에 시세가 함께</b>
        와서 매일 받습니다 — 해외주식은 종목당 1콜이라 6,100종목을 따로 받을 길이 없고,
        이 경로는 63번이면 끝납니다. 사이에 쉬어 가며 받으므로 서두르지 않습니다.
      </div>
    </div>
  );
}
