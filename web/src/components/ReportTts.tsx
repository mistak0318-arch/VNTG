import { useEffect, useState } from "react";
import { api } from "../api";
import { speechText, TTS_RATES, useTts } from "../useTts";

/**
 * 데일리 리포트 읽어주기 (2026-08-25).
 *
 * 출근길·운전 중에는 화면을 못 본다 — 그때 조간을 **귀로** 받는 자리다.
 * 읽는 것은 그 판의 **AI 정리 본문**이다. 리포트 전체(표·수치 나열)를 읽으면
 * 10분짜리 소음이 되고, AI 정리가 애초에 「사람이 훑는 3분 요약」이라 낭독에 맞는다.
 *
 * ⚠️ 낭독 장치(문장 큐·백그라운드 우회·잠금화면 버튼)는 **`useTts` 훅**으로 옮겼다
 * (2026-09-03) — 시스도 같은 걸 쓴다. 여기는 「무엇을 읽을지」만 정한다.
 */

/** 옛 import 경로를 지킨다 — `AiSummaryCard` 가 여기서 가져다 쓴다 */
export { speechText } from "../useTts";

export function ReportTts({ edition }: { edition?: string }) {
  const tts = useTts();
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // 판이 바뀌면 정지 (조간을 읽다가 석간 탭을 누른 경우)
  useEffect(() => {
    tts.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edition]);

  async function play() {
    if (!tts.supported) return;
    if (tts.status === "paused") {
      tts.resume();
      return;
    }
    setNote(null);
    tts.unlock(); // iOS 잠금 해제 + 오디오 앵커 — 제스처 안에서
    setLoading(true);
    try {
      const r = await api.publishedReport(undefined, edition);
      const text = r.report?.summary.text;
      if (!text) {
        setNote("이 판은 아직 발행 전입니다 — AI 정리가 있어야 읽을 수 있습니다.");
        tts.stop();
        return;
      }
      const label = r.report ? `${r.report.date.slice(5).replace("-", "월 ")}일 ${r.report.label}` : "";
      tts.speak(`${label}, AI 정리입니다. ${speechText(text)}`, {
        title: `VNTG 데일리 리포트${r.report?.label ? ` — ${r.report.label}` : ""}`,
        artist: "AI 정리 읽어주기",
      });
    } catch {
      setNote("리포트를 못 받았습니다.");
      tts.stop();
    } finally {
      setLoading(false);
    }
  }

  if (!tts.supported) return null;

  return (
    <div className="tts-bar">
      {tts.status === "playing" ? (
        <button className="filter-btn" onClick={tts.pause}>⏸ 잠깐</button>
      ) : (
        <button className="filter-btn active" onClick={() => void play()} disabled={loading}>
          {loading ? "받는 중…" : tts.status === "paused" ? "▶ 이어서" : "🔊 읽어주기"}
        </button>
      )}
      {(tts.status === "playing" || tts.status === "paused") && (
        <>
          <button className="filter-btn" onClick={tts.stop}>⏹</button>
          <span className="tts-pos">{tts.pos}/{tts.total} 문장</span>
        </>
      )}
      <span className="tts-rates">
        {TTS_RATES.map((x) => (
          <button
            key={x}
            className={`tts-rate${tts.rate === x ? " on" : ""}`}
            onClick={() => tts.setRate(x)}
            title="다음 문장부터 적용됩니다"
          >
            {x}×
          </button>
        ))}
      </span>
      {/*
        화면 유지 — 폰 화면이 꺼지면 브라우저 낭독이 기기에 따라 멈춘다.
        무음 앵커·잠금화면 버튼으로 대부분 이어지지만, 확실히 하려면 이걸 켠다.
      */}
      <button
        className={`tts-rate${tts.keepAwake ? " on" : ""}`}
        onClick={() => void tts.setWake(!tts.keepAwake)}
        title="켜면 낭독 중 화면이 안 꺼집니다 — 화면이 꺼지면 기기에 따라 낭독이 멈추기 때문입니다. 잠금화면의 재생/일시정지 버튼도 이 낭독에 연결됩니다."
      >
        🔅 화면 유지
      </button>
      {note && <span className="pt-n">{note}</span>}
    </div>
  );
}
