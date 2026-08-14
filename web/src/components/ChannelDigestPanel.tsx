import { useEffect, useState } from "react";
import { api, type ChannelReport } from "../api";

/**
 * 구독 채널 동향.
 *
 * 채널 200여 개를 사람이 다 읽는 건 불가능하다. 기계가 대신 읽고
 * **여러 채널이 동시에 말하고 있는 것**을 뽑아 올린다 —
 * 채널 하나가 떠드는 건 노이즈지만 열 개가 같은 종목을 말하면 신호다.
 *
 * 원래 시장 흐름 분석의 한 탭이었는데, 텔레그램은 그 자체로 독립된 정보원이라
 * 「텔레그램 동향」 대메뉴로 옮겼다.
 */

/** 몇 시간치를 훑을지. 채널이 조용한 날엔 넓게 봐야 건질 게 나온다 */
const WINDOWS = [6, 12, 24, 48];

export function ChannelDigestPanel() {
  const [reports, setReports] = useState<ChannelReport[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState(0);
  const [hours, setHours] = useState(12);
  /** 방금 실행한 결과 — 저장 안 되는 경우(0건·미리보기)에도 화면에 보여준다 */
  const [fresh, setFresh] = useState<ChannelReport | null>(null);

  function load() {
    api
      .channelReports(10)
      .then((r) => setReports(r.reports))
      .catch(() => undefined);
  }

  useEffect(load, []);

  async function run(kind: "preview" | "ai" | "aiSend" | "pickSend") {
    setBusy(kind);
    setNote(null);
    setFresh(null);
    try {
      const ai = kind === "ai" || kind === "aiSend";
      const send = kind === "aiSend" || kind === "pickSend";
      const r = await api.channelsReport({ ai, send, hours });
      setFresh(r);
      if (ai) {
        load();
        setOpen(0);
        setNote(`정리 완료 · 토큰 ${r.inputTokens}/${r.outputTokens}${send ? " · 텔레그램 발송" : ""}`);
      } else {
        setNote(
          `원본 ${r.rawCount}건 → 선별 ${r.usedCount}건 (AI 미호출 · 비용 없음)` +
            (send ? " · 텔레그램 발송" : ""),
        );
      }
      if (r.error) setNote((n) => `${n ?? ""} · ${r.error}`);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "실패");
    } finally {
      setBusy(null);
    }
  }

  const current = reports[open];

  // 보고 있는 정리본이 오늘 것이 아니면 분명히 알린다.
  // 이걸 안 보여주면 어제 리포트를 오늘 상황으로 착각하게 된다.
  const todayKst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const stale = current ? current.date !== todayKst : false;

  return (
    <>
      <div className="filter-row">
        <button className="primary-btn" disabled={busy !== null} onClick={() => run("ai")}>
          {busy === "ai" ? "정리 중…" : "AI로 정리"}
        </button>
        <button
          className="filter-btn"
          disabled={busy !== null}
          onClick={() => run("aiSend")}
          title="AI 정리본을 텔레그램으로 보냅니다"
        >
          {busy === "aiSend" ? "발송 중…" : "AI 정리 + 발송"}
        </button>
        <span className="news-scope-sep" />
        <button className="filter-btn" disabled={busy !== null} onClick={() => run("preview")}>
          {busy === "preview" ? "수집 중…" : "선별만 보기"}
        </button>
        <button
          className="filter-btn"
          disabled={busy !== null}
          onClick={() => run("pickSend")}
          title="AI를 거치지 않고 선별된 원문 그대로 텔레그램으로 보냅니다 (비용 없음)"
        >
          {busy === "pickSend" ? "발송 중…" : "선별 + 발송 (비용 없음)"}
        </button>
        <span className="news-scope-sep" />
        {WINDOWS.map((h) => (
          <button
            key={h}
            className={`filter-btn ${hours === h ? "active" : ""}`}
            onClick={() => setHours(h)}
            disabled={busy !== null}
            title={`최근 ${h}시간에 올라온 메시지만 훑습니다`}
          >
            {h}시간
          </button>
        ))}
      </div>
      {note && <div className="alert-note">{note}</div>}

      {fresh && (
        <div className="page-note">
          방금 실행 — 최근 <b>{fresh.windowHours ?? hours}시간</b> · 채널 {fresh.channels}개 · 원본{" "}
          {fresh.rawCount}건 → 선별 {fresh.usedCount}건
          {fresh.newestAt && (
            <>
              {" "}
              · 가장 최근 메시지 <b>{fresh.newestAt.slice(5, 16).replace("T", " ")}</b>
            </>
          )}
        </div>
      )}

      {stale && (
        <div className="alert-note">
          지금 보고 있는 정리본은 <b>{current.date}</b>에 만든 것입니다. 오늘 것을 보려면 위의
          「지금 AI로 정리」를 누르세요.
        </div>
      )}

      {reports.length === 0 ? (
        <div className="page-note">
          아직 정리된 기록이 없습니다. <b>설정 &gt; 구독 채널 수집</b>에서 읽을 채널을 먼저
          켜주세요. 정기 발행은 07 / 12 / 18시입니다.
        </div>
      ) : (
        <>
          <div className="filter-row">
            {reports.map((r, i) => (
              <button
                key={r.generatedAt}
                className={`filter-btn ${open === i ? "active" : ""}`}
                onClick={() => setOpen(i)}
              >
                {r.generatedAt.slice(5, 16).replace("T", " ")}
              </button>
            ))}
          </div>

          {current && (
            <>
              <div className="chan-report-meta">
                <b>{current.generatedAt.slice(0, 16).replace("T", " ")}</b> 생성 · 채널{" "}
                {current.channels}개 · 원본 {current.rawCount}건 → 선별 {current.usedCount}건 · 토큰{" "}
                {current.inputTokens}/{current.outputTokens}
                {current.skipped.length > 0 && ` · 건너뜀 ${current.skipped.length}개`}
              </div>
              {current.newestAt && (
                <div className="chan-report-meta">
                  정리한 메시지 구간 {current.oldestAt?.slice(5, 16).replace("T", " ")} ~{" "}
                  {current.newestAt.slice(5, 16).replace("T", " ")}
                  {current.windowHours ? ` (최근 ${current.windowHours}시간 훑음)` : ""}
                </div>
              )}

              {current.summary ? (
                <pre className="alert-preview">{current.summary}</pre>
              ) : (
                <div className="page-note">{current.error ?? "요약이 없습니다."}</div>
              )}

              {current.items.length > 0 && (
                <>
                  <h3 className="section-heading">근거 — 선별된 원문 상위 15건</h3>
                  <div className="chan-items">
                    {current.items.slice(0, 15).map((it, i) => (
                      <div className="chan-item" key={i}>
                        <div className="chan-item-head">
                          {it.coverage > 1 && (
                            <span className="news-tag hot">{it.coverage}개 채널</span>
                          )}
                          {it.mentions.length > 0 && (
                            <span className="news-tag watch">★ {it.mentions.join(", ")}</span>
                          )}
                          <span className="chan-item-time">{new Date(it.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
                        </div>
                        <div className="chan-item-text">{it.text}</div>
                        <div className="chan-item-src">{it.channels.join(" · ")}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}

      <div className="table-note">
        AI 정리는 <b>채널에서 나온 주장</b>이지 확인된 사실이 아닙니다. 아래 원문을 같이 두는 이유가
        그것입니다 — 요약만 믿지 말고 몇 개 채널이 말했는지, 누가 말했는지 보고 판단하세요.
      </div>
    </>
  );
}