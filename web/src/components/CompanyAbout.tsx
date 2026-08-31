import { useEffect, useState } from "react";
import { api, type CompanyBrief } from "../api";

/**
 * 이 회사가 무슨 일을 하나 — 「기업·재무」 탭 맨 위.
 *
 * ## 답해야 할 것은 셋뿐이다
 *
 *   1. 무슨 일로 돈을 버는 회사인가
 *   2. 왜 지금 거론되는가
 *   3. 이익은 어느 쪽으로 가고 있나
 *
 * ## ⚠️ 회사 명세를 늘어놓지 않는다
 *
 * 처음엔 DART 기업개황(대표·설립일·결산월·본사 주소·홈페이지)을 정의목록으로
 * 깔았다. 벤티지가 바로 잘랐다 — "종목정보 이딴거 넣을거면 안넣는게 낫지 않아?" ·
 * "이런거 알자고 내가 얘기한거 아닌거 알텐데 너도".
 *
 * 맞는 말이다. **대표 이름과 본사 주소는 위 세 질문 중 무엇에도 답하지 않는다.**
 * 자리는 제일 크게 차지하면서. 「기타 금융업」이나 「시가총액규모대 › 금융업 ›
 * 금융업」 같은 분류도 마찬가지다 — 분류일 뿐 설명이 아니다.
 *
 * 그래서 그 값들은 **화면에서 뺐다.** 다만 서버는 계속 받는다 — 모델이 회사를
 * 특정하는 데 쓰는 재료로는 값어치가 있기 때문이다(같은 이름의 다른 회사, 지주사와
 * 사업회사 구분). **사람이 읽을 값이 아니라 모델이 읽을 값**이라는 게 결론이다.
 *
 * ## 버튼이지 자동이 아니다
 *
 * 벤티지 (2026-09-01): "버튼 하나 줘서 AI로 기업 정보 긁어오기 이런걸로 해가지고
 * 선택권을 줘. 그래야 토큰 아끼지."
 *
 * 종목발굴에서 방향키로 백 종목을 넘기는 게 이 앱을 쓰는 방식이다. 열 때마다
 * AI 가 돌면 훑어보기만 해도 돈이 나간다. 그래서 화면이 열릴 때는 **이미 엮어 둔
 * 것이 있나만 확인**하고(조회 0회 · AI 0회), 없으면 버튼만 보인다.
 *
 * ## 낡음을 숨기지 않는다
 *
 * 서술에는 **엮은 날짜가 붙어 있다.** 「최근 동향」은 매주 바뀌는데 날짜가 없으면
 * 한 달 전 이야기가 오늘 것처럼 보인다 — 틀린 정보가 확신에 차서 떠 있는 게
 * 없는 것보다 나쁘다.
 */

function kstToday(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60_000);
  return kst.toISOString().slice(0, 10);
}

export function CompanyAbout({
  code,
  name,
  price = null,
}: {
  code: string;
  name: string;
  /** 목표주가 상승여력을 재는 데 쓴다. 없으면 그 재료만 빠진다 */
  price?: number | null;
}) {
  const [brief, setBrief] = useState<CompanyBrief | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /* 열 때는 **캐시만** 본다 — AI 를 안 부른다 */
  useEffect(() => {
    let alive = true;
    setBrief(null);
    setErr(null);
    void api
      .companyBrief(code)
      .then((r) => alive && setBrief(r.brief))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [code]);

  async function run(force: boolean) {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.companyBriefRun(code, name, { force, price });
      if (r.brief) setBrief(r.brief);
      if (r.error) setErr(r.error);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "엮기에 실패했습니다");
    } finally {
      setBusy(false);
    }
  }

  const stale = brief !== null && brief.day !== kstToday();

  return (
    <div className="co-about">
      {brief ? (
        <>
          <div className="co-about-bar">
            <b>무슨 회사인가</b>
            <span className={`co-about-day${stale ? " stale" : ""}`}>
              {stale ? `${brief.day} 엮음 — 그 뒤로 소식이 바뀌었을 수 있습니다` : "오늘 엮음"}
            </span>
            <button className="filter-btn" onClick={() => void run(true)} disabled={busy}>
              {busy ? "엮는 중..." : "다시 엮기"}
            </button>
          </div>
          <div className="co-about-text">{brief.text}</div>
          <div className="table-note co-about-src">
            {brief.sources.length > 0 && <>엮은 것: {brief.sources.join(" · ")} · </>}
            {brief.model ?? "기본 모델"} · 입력 {brief.inputTokens.toLocaleString("ko-KR")} / 출력{" "}
            {brief.outputTokens.toLocaleString("ko-KR")} 토큰
          </div>
        </>
      ) : (
        <div className="co-about-empty">
          <button className="filter-btn primary" onClick={() => void run(false)} disabled={busy}>
            {busy ? "엮는 중..." : "🤖 이 회사가 무슨 일을 하나"}
          </button>
          <span className="table-note">
            테마 편입 사유 · 공시 · 뉴스 · 분기 실적 · 목표주가를 엮어 <b>무슨 일로 버는 회사인지 ·
            왜 지금 거론되는지 · 이익이 어느 쪽인지</b> 세 문단으로 정리합니다. 누를 때만 부르고,
            같은 날 다시 누르면 부르지 않습니다.
          </span>
        </div>
      )}
      {err && <div className="error-banner">{err}</div>}
    </div>
  );
}
