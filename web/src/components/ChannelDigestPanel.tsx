import { useEffect, useState } from "react";
import { api, type ChannelReport, type PublishJob } from "../api";
import { ProgressSteps } from "./ProgressSteps";

/**
 * 구독 채널 동향.
 *
 * 채널 200여 개를 사람이 다 읽는 건 불가능하다. 기계가 대신 읽고
 * **여러 채널이 동시에 말하고 있는 것**을 뽑아 올린다 —
 * 채널 하나가 떠드는 건 노이즈지만 열 개가 같은 종목을 말하면 신호다.
 *
 * 조작부를 다시 짰다. 예전엔 버튼 네 개가 나란히 있었는데
 * (AI로 정리 / AI 정리+발송 / 선별만 보기 / 선별+발송) 사실 이건 **두 축**이다 —
 * *무엇을* 만들 것인가(선별 vs AI 정리) × *어디로* 보낼 것인가(화면 vs 텔레그램).
 * 네 개를 평평하게 늘어놓으니 뭐가 뭔지 알 수 없었다.
 *
 * 수집 구간도 시간 단위(6·12·24·48시간)뿐이었다. 텔레그램의 무기는 신속성인데
 * 최소가 6시간이면 "방금 뭐가 돌았나"를 볼 수가 없다. 분 단위부터 준다.
 */

/** 수집 구간. 앞쪽이 짧다 — 평소에 쓰는 건 이쪽이다 */
const WINDOWS = [
  { min: 15, label: "15분" },
  { min: 30, label: "30분" },
  { min: 60, label: "1시간" },
  { min: 180, label: "3시간" },
  { min: 360, label: "6시간" },
  { min: 720, label: "12시간" },
];

function windowLabel(min: number | undefined): string {
  if (!min) return "-";
  const hit = WINDOWS.find((w) => w.min === min);
  if (hit) return hit.label;
  if (min < 60) return `${min}분`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
}

/** ISO → "08-14 13:31" (KST) */
function stamp(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return d.toISOString().slice(5, 16).replace("T", " ");
}

export function ChannelDigestPanel() {
  const [reports, setReports] = useState<ChannelReport[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState(0);
  const [minutes, setMinutes] = useState(60);
  /** 무엇을 만들 것인가 */
  const [mode, setMode] = useState<"pick" | "ai">("pick");
  /** 방금 실행한 결과 — 저장 안 되는 경우(0건·미리보기)에도 화면에 보여준다 */
  const [fresh, setFresh] = useState<ChannelReport | null>(null);
  /** 진행 상황 — 채널 200개를 읽는 동안 얼마나 남았는지 보여준다 */
  const [job, setJob] = useState<PublishJob | null>(null);

  function load() {
    api
      .channelReports(10)
      .then((r) => setReports(r.reports))
      .catch(() => undefined);
  }

  useEffect(load, []);

  async function run(send: boolean) {
    const ai = mode === "ai";
    setBusy(send ? "send" : "view");
    setNote(null);
    setFresh(null);
    setJob(null);
    try {
<<<<<<< HEAD
      const r = await api.channelsReport({ ai, send, minutes });
      setFresh(r);
      if (ai) {
        load();
        setOpen(0);
        setNote(
          `정리 완료 · 토큰 ${r.inputTokens}/${r.outputTokens}${send ? " · 텔레그램 발송" : ""}`,
        );
      } else {
        setNote(
          `원본 ${r.rawCount}건 → 선별 ${r.usedCount}건 (AI 미호출 · 비용 없음)` +
            (send ? " · 텔레그램 발송" : ""),
        );
      }
      if (r.error) setNote((n) => `${n ?? ""} · ${r.error}`);
=======
      const { jobId } = await api.channelsReport({ ai, send, minutes });
      // 리포트 발행과 같은 방식 — 곧바로 jobId 를 받고 2초마다 단계를 물어본다
      let misses = 0;
      const timer = setInterval(async () => {
        try {
          const j = await api.channelsReportStatus(jobId);
          misses = 0;
          setJob(j);
          if (j.status === "running") return;
          clearInterval(timer);
          setBusy(null);
          const r = j.report as ChannelReport | undefined;
          if (j.status === "error" || !r) {
            setNote(j.error ?? "실패");
            return;
          }
          setFresh(r);
          if (ai) {
            load();
            setOpen(0);
            setNote(
              `정리 완료 · 토큰 ${r.inputTokens}/${r.outputTokens}${send ? " · 텔레그램 발송" : ""}`,
            );
          } else {
            setNote(
              `원본 ${r.rawCount}건 → 선별 ${r.usedCount}건 (AI 미호출 · 비용 없음)` +
                (send ? " · 텔레그램 발송" : ""),
            );
          }
          if (r.error) setNote((n) => `${n ?? ""} · ${r.error}`);
        } catch {
          // 서버가 재시작하면 작업이 사라진다. 삼키면 영영 "진행 중"으로 남으므로 끊는다
          misses += 1;
          if (misses >= 3) {
            clearInterval(timer);
            setBusy(null);
            setJob(null);
            setNote("진행 상황을 잃었습니다 (서버 재시작?). 새로고침 후 확인하세요.");
          }
        }
      }, 2000);
>>>>>>> a515a0e3aa60d068114fb1dd4a9674f785b8118e
    } catch (err) {
      setNote(err instanceof Error ? err.message : "실패");
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
      <div className="tg-controls">
        <div className="tg-ctl">
          <span className="tg-ctl-label">수집 구간</span>
          <div className="tg-ctl-body">
            {WINDOWS.map((w) => (
              <button
                key={w.min}
                className={`filter-btn ${minutes === w.min ? "active" : ""}`}
                onClick={() => setMinutes(w.min)}
                disabled={busy !== null}
              >
                {w.label}
              </button>
            ))}
            <span className="tg-ctl-hint">전에 올라온 메시지만 훑습니다</span>
          </div>
        </div>

        <div className="tg-ctl">
          <span className="tg-ctl-label">무엇을</span>
          <div className="tg-ctl-body">
            <button
              className={`filter-btn ${mode === "pick" ? "active" : ""}`}
              onClick={() => setMode("pick")}
              disabled={busy !== null}
            >
              선별 원문
            </button>
            <button
              className={`filter-btn ${mode === "ai" ? "active" : ""}`}
              onClick={() => setMode("ai")}
              disabled={busy !== null}
            >
              AI 정리
            </button>
            <span className="tg-ctl-hint">
              {mode === "pick" ? (
                <>
                  걸러낸 원문을 그대로 — <b>비용 없음</b>
                </>
              ) : (
                <>
                  여러 채널이 겹친 주제로 재구성 — <b>호출당 비용</b>
                </>
              )}
            </span>
          </div>
        </div>

        <div className="tg-ctl">
          <span className="tg-ctl-label">어디로</span>
          <div className="tg-ctl-body">
            <button className="algo-run-btn" disabled={busy !== null} onClick={() => void run(false)}>
              {busy === "view" ? "가져오는 중…" : "화면에서 보기"}
            </button>
            <button className="filter-btn" disabled={busy !== null} onClick={() => void run(true)}>
              {busy === "send" ? "발송 중…" : "텔레그램 발송"}
            </button>
          </div>
        </div>
      </div>

      {note && <div className="alert-note">{note}</div>}
      {job && <ProgressSteps job={job} />}

      {fresh && (
        <div className="page-note">
          방금 실행 — 최근 <b>{windowLabel(fresh.windowMinutes ?? minutes)}</b> · 채널{" "}
          {fresh.channels}개 · 원본 {fresh.rawCount}건 → 선별 {fresh.usedCount}건
          {fresh.newestAt && (
            <>
              {" "}
              · 가장 최근 메시지 <b>{stamp(fresh.newestAt)}</b>
            </>
          )}
        </div>
      )}

      {stale && (
        <div className="alert-note">
          지금 보고 있는 정리본은 <b>{current.date}</b>에 만든 것입니다. 오늘 것을 보려면 위에서
          「AI 정리」를 고르고 「화면에서 보기」를 누르세요.
        </div>
      )}

      {reports.length === 0 ? (
        <div className="page-note">
          아직 정리된 기록이 없습니다. <b>채널 관리</b> 탭에서 읽을 채널을 먼저 켜주세요. 정기
          발행은 07 / 12 / 18시입니다.
        </div>
      ) : (
        <>
          {/*
            예전엔 정리본마다 버튼을 하나씩 깔았다. 하루에 몇 번만 돌 때는 괜찮았지만
            자주 돌리면 버튼이 화면을 덮는다. 목록은 드롭다운으로 접는다.
          */}
          <div className="filter-row">
            <span className="tg-ctl-label">지난 정리본</span>
            <select
              className="tg-select"
              value={open}
              onChange={(e) => setOpen(Number(e.target.value))}
            >
              {reports.map((r, i) => (
                <option key={r.generatedAt} value={i}>
                  {stamp(r.generatedAt)} · 선별 {r.usedCount}건
                  {r.summary ? "" : " (요약 없음)"}
                </option>
              ))}
            </select>
            <span className="tg-ctl-hint">최근 {reports.length}건 보관</span>
          </div>

          {current && (
            <>
              <div className="chan-report-meta">
                <b>{stamp(current.generatedAt)}</b> 생성 · 채널 {current.channels}개 · 원본{" "}
                {current.rawCount}건 → 선별 {current.usedCount}건 · 토큰 {current.inputTokens}/
                {current.outputTokens}
                {current.skipped.length > 0 && ` · 건너뜀 ${current.skipped.length}개`}
              </div>
              {current.newestAt && (
                <div className="chan-report-meta">
                  정리한 메시지 구간 {stamp(current.oldestAt ?? current.newestAt)} ~{" "}
                  {stamp(current.newestAt)}
                  {current.windowMinutes ? ` (최근 ${windowLabel(current.windowMinutes)} 훑음)` : ""}
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
                          <span className="chan-item-time">{stamp(it.at).slice(6)}</span>
                        </div>
                        {/*
                          무엇에 대한 얘기인지를 본문보다 먼저 보여준다.
                          못 찾았으면 비워두지 않고 "알 수 없음"이라고 적는다 —
                          빈칸이면 태그가 없는 건지 붙이다 만 건지 구분이 안 된다.
                        */}
                        <div className="chan-tags">
                          <span className="chan-tag stock">
                            🏷 {it.stocks && it.stocks.length > 0 ? it.stocks.join(", ") : "알 수 없음"}
                          </span>
                          <span className="chan-tag theme">
                            🎯 {it.themes && it.themes.length > 0 ? it.themes.join(", ") : "미정"}
                          </span>
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
