import { useEffect, useRef, useState } from "react";
import { api } from "../api";

/**
 * 데일리 리포트 읽어주기 (2026-08-25).
 *
 * 출근길·운전 중에는 화면을 못 본다 — 그때 조간을 **귀로** 받는 자리다.
 * 읽는 것은 그 판의 **AI 정리 본문**이다. 리포트 전체(표·수치 나열)를 읽으면
 * 10분짜리 소음이 되고, AI 정리가 애초에 「사람이 훑는 3분 요약」이라 낭독에 맞는다.
 *
 * ## 왜 브라우저 내장 음성(Web Speech API)인가
 *
 * 서버 TTS(mp3 생성)는 키·비용·저장이 따라온다. 브라우저 내장은 공짜에 즉시고,
 * 폰(안드로이드 구글 TTS·iOS 유나)의 한국어 음성은 낭독용으로 충분하다.
 * 나중에 텔레그램으로 mp3 를 보내고 싶어지면 그때 서버판을 얹는다 — 이 컴포넌트의
 * 문장 다듬기(speechText)는 그대로 재사용된다.
 *
 * ## 크롬 15초 버그
 *
 * 크롬(데스크톱)은 utterance 하나가 15초를 넘으면 소리 없이 멈춘다 — 알려진
 * 버그다. 그래서 **문장 단위로 잘라 큐**로 잇는다. 문장 단위면 일시정지·재개도
 * 문장 경계에서 자연스럽다.
 *
 * ## iOS 제스처 잠금
 *
 * iOS 는 사용자 제스처 안에서 speak() 가 한 번 불려야 그 뒤가 풀린다. 재생 버튼을
 * 누른 **그 자리에서** 빈 utterance 를 먼저 말하게 해 잠금을 풀고, 그다음 본문을
 * 받아 읽는다.
 *
 * ## 백그라운드 재생 (2026-08-26)
 *
 * speechSynthesis 는 **오디오 트랙이 아니라서** 폰이 탭을 얼리면 같이 멈춘다.
 * 그래서 음악 앱들이 쓰는 우회를 셋 얹는다:
 *   1. **무음 오디오 앵커** — 재생 중에 거의 무음인 <audio loop> 를 같이 튼다.
 *      오디오가 도는 페이지는 브라우저가 안 얼려서, 탭을 바꾸거나 화면을 꺼도
 *      낭독이 이어질 확률이 크게 오른다(안드로이드 크롬 기준. 기기마다 다르다).
 *   2. **Media Session** — 잠금화면·이어폰 버튼에 재생/일시정지/정지가 연결된다.
 *   3. **워치독** — 그래도 얼었다 풀리면 onend 를 놓쳐 큐가 죽는다. 3초마다
 *      「재생 중이라는데 입이 다물려 있으면」 다음 문장을 다시 잇는다.
 * 화면 유지(Wake Lock) 토글은 마지막 안전판이다 — 켜면 화면이 안 꺼져서
 * 어떤 기기서든 끊기지 않는다(주머니에 넣는 출근길용).
 */

/** 거의 무음 1초짜리 WAV — 오디오 포커스를 잡아 두는 앵커. 런타임에 만들어 Blob URL 로 */
function silentWavUrl(): string {
  const sampleRate = 8000;
  const samples = sampleRate; // 1초
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + samples * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples * 2, true);
  // 데이터부는 전부 0 = 무음
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

/** 마크다운·기호를 낭독용 문장으로 */
export function speechText(md: string): string {
  return (
    md
      .replace(/^##\s*/gm, "") // 제목 표식
      .replace(/\*\*([^*]+)\*\*/g, "$1") // 굵게
      .replace(/^[-*•]\s*/gm, "") // 불릿
      .replace(/^\d+\.\s*/gm, "")
      /* 기호는 읽는 말로 — TTS 가 「%p」를 「퍼센트 피」로 읽으면 못 알아듣는다 */
      .replace(/%p/g, "퍼센트포인트")
      .replace(/([+＋])\s?(?=\d)/g, "플러스 ")
      .replace(/([-−▼])\s?(?=\d)/g, "마이너스 ")
      .replace(/([▲])\s?(?=\d)/g, "플러스 ")
      .replace(/·/g, ", ")
      .replace(/→/g, "에서 ")
      .replace(/[📌💰🎯🌡️🔥⭐📈📉⚡🛑✍🌟]/gu, "") // 자주 쓰는 이모지
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}

/** 문장 단위로 자른다 — 크롬 15초 버그 회피 + 진행 표시의 단위 */
function toSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?다요임함])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

/**
 * ko-KR 음성 고르기 — **자연스러운 순서**로.
 *
 *   1) 「Natural」 이 이름에 든 것 — **엣지(Edge)의 신경망 음성**(SunHi·InJoon 등).
 *      크롬엔 없고 엣지에만 있는데, 무료 음성 중 압도적으로 자연스럽다.
 *   2) Google 한국어 — 안드로이드 폰의 기본. 무난하다.
 *   3) 나머지 ko 아무거나 — 윈도 크롬의 Heami 가 여기다(로봇 티가 난다.
 *      PC 에서 자연스러운 톤을 원하면 **엣지로 여는 게** 정답이다).
 */
function pickVoice(): SpeechSynthesisVoice | null {
  const all = window.speechSynthesis.getVoices();
  const ko = all.filter((v) => v.lang.toLowerCase().startsWith("ko"));
  return (
    ko.find((v) => /natural/i.test(v.name)) ??
    ko.find((v) => /google/i.test(v.name)) ??
    ko[0] ??
    null
  );
}

const RATES = [1, 1.25, 1.5] as const;

export function ReportTts({ edition }: { edition?: string }) {
  const [status, setStatus] = useState<"idle" | "loading" | "playing" | "paused">("idle");
  const [rate, setRate] = useState<number>(1.25);
  const [pos, setPos] = useState(0);
  const [total, setTotal] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;

  /* 큐 상태는 ref 로 — utterance onend 콜백이 최신 값을 봐야 한다 */
  const sentences = useRef<string[]>([]);
  const idx = useRef(0);
  const stopped = useRef(false);
  const rateRef = useRef(rate);
  rateRef.current = rate;
  /* 백그라운드 재생 장치들 */
  const anchor = useRef<HTMLAudioElement | null>(null);
  const wakeLock = useRef<{ release: () => Promise<void> } | null>(null);
  const [keepAwake, setKeepAwake] = useState(false);
  const statusRef = useRef(status);
  statusRef.current = status;

  // 화면을 떠나면 입을 다문다 — 다른 탭에서 계속 떠들면 그게 버그다
  useEffect(() => {
    return () => {
      window.speechSynthesis?.cancel();
      anchor.current?.pause();
      void wakeLock.current?.release().catch(() => undefined);
    };
  }, []);

  /*
   * 워치독 — 페이지가 얼었다 풀리면 utterance 의 onend 가 사라져 큐가 조용히 죽는다.
   * 「재생 중이라는데 실제로는 아무 말도 안 하고 있으면」 다음 문장을 다시 잇는다.
   */
  useEffect(() => {
    if (status !== "playing") return;
    const t = setInterval(() => {
      const s = window.speechSynthesis;
      if (statusRef.current !== "playing" || stopped.current) return;
      if (!s.speaking && !s.pending && idx.current < sentences.current.length) speakNext();
    }, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  /* 무음 앵커 시작/정지 — 재생 상태를 따라간다 */
  function anchorOn() {
    if (!anchor.current) {
      const a = new Audio(silentWavUrl());
      a.loop = true;
      a.volume = 0.001; // 완전 0이면 일부 기기가 오디오 포커스를 안 준다
      anchor.current = a;
    }
    void anchor.current.play().catch(() => undefined);
  }
  function anchorOff() {
    anchor.current?.pause();
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "none";
  }

  /* 잠금화면·이어폰 버튼 연결 */
  function mediaSessionOn(label: string) {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: `VNTG 데일리 리포트${label ? ` — ${label}` : ""}`,
        artist: "AI 정리 읽어주기",
      });
      navigator.mediaSession.playbackState = "playing";
      navigator.mediaSession.setActionHandler("play", () => void play());
      navigator.mediaSession.setActionHandler("pause", () => pause());
      navigator.mediaSession.setActionHandler("stop", () => stop());
    } catch {
      /* 미지원 브라우저 — 없어도 낭독은 된다 */
    }
  }

  /* 화면 유지 — 어떤 기기서든 확실히 안 끊기게 하는 마지막 안전판 */
  async function setWake(on: boolean) {
    setKeepAwake(on);
    try {
      if (on) {
        type WakeNav = Navigator & {
          wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> };
        };
        wakeLock.current = (await (navigator as WakeNav).wakeLock?.request("screen")) ?? null;
      } else {
        await wakeLock.current?.release();
        wakeLock.current = null;
      }
    } catch {
      setKeepAwake(false);
    }
  }

  /* 화면이 다시 보이면: 풀린 wake lock 재획득 + 끊긴 낭독을 워치독보다 빨리 잇는다 */
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      if (keepAwake && !wakeLock.current) void setWake(true);
      const s = window.speechSynthesis;
      if (statusRef.current === "playing" && !s.speaking && !s.pending && !stopped.current) {
        speakNext();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keepAwake]);
  // 판이 바뀌면 정지 (조간을 읽다가 석간 탭을 누른 경우)
  useEffect(() => {
    stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edition]);

  function speakNext() {
    if (stopped.current) return;
    const i = idx.current;
    if (i >= sentences.current.length) {
      setStatus("idle");
      setPos(0);
      anchorOff(); // 다 읽었으면 오디오 포커스도 놓는다
      return;
    }
    const u = new SpeechSynthesisUtterance(sentences.current[i]);
    const voice = pickVoice();
    if (voice) u.voice = voice;
    u.lang = "ko-KR";
    u.rate = rateRef.current;
    u.onend = () => {
      idx.current += 1;
      setPos(idx.current);
      speakNext();
    };
    u.onerror = () => {
      // 한 문장 실패로 낭독 전체가 죽지 않게 — 다음 문장으로
      idx.current += 1;
      setPos(idx.current);
      speakNext();
    };
    window.speechSynthesis.speak(u);
  }

  async function play() {
    if (!supported) return;
    if (status === "paused") {
      window.speechSynthesis.resume();
      anchorOn();
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
      setStatus("playing");
      return;
    }
    setNote(null);
    // iOS 잠금 해제 — 제스처 안에서 speak 가 한 번 불려야 한다
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(""));
    // 오디오 앵커도 제스처 안에서 시작해야 자동재생 정책에 안 막힌다
    anchorOn();

    setStatus("loading");
    try {
      const r = await api.publishedReport(undefined, edition);
      const text = r.report?.summary.text;
      if (!text) {
        setNote("이 판은 아직 발행 전입니다 — AI 정리가 있어야 읽을 수 있습니다.");
        setStatus("idle");
        anchorOff();
        return;
      }
      const label = r.report ? `${r.report.date.slice(5).replace("-", "월 ")}일 ${r.report.label}` : "";
      sentences.current = toSentences(`${label}, AI 정리입니다. ${speechText(text)}`);
      idx.current = 0;
      stopped.current = false;
      setTotal(sentences.current.length);
      setPos(0);
      setStatus("playing");
      mediaSessionOn(r.report?.label ?? "");
      speakNext();
    } catch {
      setNote("리포트를 못 받았습니다.");
      setStatus("idle");
      anchorOff();
    }
  }

  function pause() {
    window.speechSynthesis.pause();
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
    setStatus("paused");
  }

  function stop() {
    stopped.current = true;
    window.speechSynthesis?.cancel();
    anchorOff();
    setStatus("idle");
    setPos(0);
  }

  if (!supported) return null;

  return (
    <div className="tts-bar">
      {status === "playing" ? (
        <button className="filter-btn" onClick={pause}>⏸ 잠깐</button>
      ) : (
        <button className="filter-btn active" onClick={() => void play()} disabled={status === "loading"}>
          {status === "loading" ? "받는 중…" : status === "paused" ? "▶ 이어서" : "🔊 읽어주기"}
        </button>
      )}
      {(status === "playing" || status === "paused") && (
        <>
          <button className="filter-btn" onClick={stop}>⏹</button>
          <span className="tts-pos">{pos}/{total} 문장</span>
        </>
      )}
      <span className="tts-rates">
        {RATES.map((x) => (
          <button
            key={x}
            className={`tts-rate${rate === x ? " on" : ""}`}
            onClick={() => setRate(x)}
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
        className={`tts-rate${keepAwake ? " on" : ""}`}
        onClick={() => void setWake(!keepAwake)}
        title="켜면 낭독 중 화면이 안 꺼집니다 — 화면이 꺼지면 기기에 따라 낭독이 멈추기 때문입니다. 잠금화면의 재생/일시정지 버튼도 이 낭독에 연결됩니다."
      >
        🔅 화면 유지
      </button>
      {note && <span className="pt-n">{note}</span>}
    </div>
  );
}
