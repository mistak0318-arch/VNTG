import { useCallback, useEffect, useRef, useState } from "react";

/**
 * **읽어주기** — 데일리 리포트가 쓰던 낭독 장치를 훅으로 뽑았다 (2026-09-03).
 *
 * 벤티지: "시스에 한글로 읽어주기 기능 추가해줄 수 있어? 백그라운드에서도 재생되고."
 *
 * 리포트(`ReportTts`)와 시스(`SysAssist`)가 **같은 장치**를 쓴다 — 두 벌이 되면 백그라운드
 * 우회처럼 까다로운 부분이 한쪽만 고쳐진다. 컴포넌트는 「무엇을 읽을지」만 정하고, 여기는
 * 「어떻게 끊기지 않고 읽을지」만 안다.
 *
 * ## 왜 브라우저 내장 음성(Web Speech API)인가
 *
 * 서버 TTS(mp3 생성)는 키·비용·저장이 따라온다. 브라우저 내장은 공짜에 즉시고, 폰
 * (안드로이드 구글 TTS·iOS 유나)의 한국어 음성은 낭독용으로 충분하다.
 *
 * ## 크롬 15초 버그
 *
 * 크롬(데스크톱)은 utterance 하나가 15초를 넘으면 소리 없이 멈춘다 — 알려진 버그다.
 * 그래서 **문장 단위로 잘라 큐**로 잇는다. 일시정지·재개도 문장 경계라 자연스럽다.
 *
 * ## iOS 제스처 잠금
 *
 * iOS 는 사용자 제스처 안에서 `speak()` 가 한 번 불려야 그 뒤가 풀린다. 버튼을 누른
 * **그 자리에서** `unlock()` 을 부르고(빈 utterance + 오디오 앵커), 본문은 나중에 넘겨도 된다.
 *
 * ## 백그라운드 재생
 *
 * speechSynthesis 는 **오디오 트랙이 아니라서** 폰이 탭을 얼리면 같이 멈춘다. 음악 앱들이
 * 쓰는 우회를 셋 얹는다:
 *   1. **무음 오디오 앵커** — 거의 무음인 `<audio loop>` 를 같이 튼다. 오디오가 도는 페이지는
 *      브라우저가 잘 안 얼린다(안드로이드 크롬 기준. 기기마다 다르다).
 *   2. **Media Session** — 잠금화면·이어폰 버튼에 재생/일시정지/정지가 붙는다.
 *   3. **워치독** — 그래도 얼었다 풀리면 `onend` 를 놓쳐 큐가 죽는다. 3초마다 「재생 중이라는데
 *      입이 다물려 있으면」 다음 문장을 다시 잇는다.
 * 화면 유지(Wake Lock)는 마지막 안전판 — 켜면 화면이 안 꺼져 어떤 기기서든 안 끊긴다.
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
      .replace(/^#{1,6}\s*/gm, "") // 제목 표식
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
      /*
       * ⚠️ **천 단위 쉼표를 뗀다** (2026-09-03 실측). 붙여 두면 엔진이 「79,400」을 「칠십구, 사백」으로
       * 끊어 읽는다. 쉼표가 없으면 「칠만 구천 사백」으로 제대로 읽는다.
       * lookbehind 라 겹치지 않아 1,234,567 도 한 번에 다 잡힌다.
       */
      .replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, "")
      /* 줄표는 그냥 두면 침묵이 된다 — 쉼표로 바꿔 끊어 읽게 */
      .replace(/\s*[—–]\s*/g, ", ")
      .replace(/[📌💰🎯🌡️🔥⭐📈📉⚡🛑✍🌟📅📝📊🔄🚀🚪🌈💬✓✕]/gu, "") // 자주 쓰는 기호
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}

/**
 * 문장 단위로 자른다 — 크롬 15초 버그 회피 + 진행 표시의 단위.
 *
 * ⚠️ 종결어미가 없는 글도 있다 (2026-09-03, 시스 카드를 읽히면서 드러났다). 신호등 기준 줄은
 * 「눌림목 20일 고점 대비 -10.2% , 20일선 이격 … , 거래량 패턴 …」처럼 **쉼표로만 이어진 한 덩어리**라
 * 문장 규칙에 안 걸리고, 그대로 읽히면 1분짜리 utterance 가 되어 15초에서 잘린다.
 * 그래서 잘린 조각이 길면 **쉼표에서 한 번 더** 쪼갠다.
 */
const MAX_CHUNK = 120;
function splitLong(s: string): string[] {
  if (s.length <= MAX_CHUNK) return [s];
  const out: string[] = [];
  let cur = "";
  /*
   * 숫자 사이 쉼표(1,234)는 자르지 않는다 — speechText 가 대개 떼지만 여기서도 지킨다.
   * ⚠️ **논캡처 그룹**이어야 한다. split 은 캡처 그룹을 결과 배열에 끼워 넣어서,
   * `(\D|$)` 로 쓰면 매칭 안 된 자리마다 `undefined` 조각이 생긴다(실측).
   */
  for (const part of s.split(/(?<!\d),\s*(?!\d{3}(?:\D|$))/)) {
    const next = cur ? `${cur}, ${part}` : part;
    if (next.length > MAX_CHUNK && cur) {
      out.push(cur);
      cur = part;
    } else {
      cur = next;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function toSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?다요임함])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1)
    .flatMap(splitLong);
}

/**
 * ko-KR 음성 고르기 — **자연스러운 순서**로.
 *
 *   1) 「Natural」 이 이름에 든 것 — **엣지(Edge)의 신경망 음성**(SunHi·InJoon 등). 무료 중 최고.
 *   2) Google 한국어 — 안드로이드 폰의 기본. 무난하다.
 *   3) 나머지 ko 아무거나 — 윈도 크롬의 Heami(로봇 티가 난다. PC 는 엣지로 여는 게 정답).
 */
function pickVoice(): SpeechSynthesisVoice | null {
  const all = window.speechSynthesis.getVoices();
  const ko = all.filter((v) => v.lang.toLowerCase().startsWith("ko"));
  return ko.find((v) => /natural/i.test(v.name)) ?? ko.find((v) => /google/i.test(v.name)) ?? ko[0] ?? null;
}

export type TtsStatus = "idle" | "playing" | "paused";

export const TTS_RATES = [1, 1.25, 1.5] as const;

export function useTts(): {
  supported: boolean;
  status: TtsStatus;
  pos: number;
  total: number;
  rate: number;
  setRate: (r: number) => void;
  keepAwake: boolean;
  setWake: (on: boolean) => Promise<void>;
  /** 버튼을 누른 **그 자리에서** 부른다 — iOS 잠금 해제 + 오디오 앵커 시작 */
  unlock: () => void;
  /** 텍스트를 읽는다. 이미 읽는 중이면 그것을 버리고 새로 */
  speak: (text: string, meta?: { title?: string; artist?: string }) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
} {
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  const [status, setStatus] = useState<TtsStatus>("idle");
  const [pos, setPos] = useState(0);
  const [total, setTotal] = useState(0);
  const [rate, setRate] = useState(1.25);
  const [keepAwake, setKeepAwake] = useState(false);

  /* 큐 상태는 ref 로 — utterance onend 콜백이 최신 값을 봐야 한다 */
  const sentences = useRef<string[]>([]);
  const idx = useRef(0);
  const stopped = useRef(false);
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const anchor = useRef<HTMLAudioElement | null>(null);
  const wakeLock = useRef<{ release: () => Promise<void> } | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;

  const anchorOn = useCallback(() => {
    if (!anchor.current) {
      const a = new Audio(silentWavUrl());
      a.loop = true;
      a.volume = 0.001; // 완전 0이면 일부 기기가 오디오 포커스를 안 준다
      anchor.current = a;
    }
    void anchor.current.play().catch(() => undefined);
  }, []);

  const anchorOff = useCallback(() => {
    anchor.current?.pause();
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "none";
  }, []);

  const speakNext = useCallback(() => {
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
    const next = () => {
      idx.current += 1;
      setPos(idx.current);
      speakNext();
    };
    u.onend = next;
    /* 한 문장이 실패해도 낭독 전체가 죽지 않게 — 다음 문장으로 */
    u.onerror = next;
    window.speechSynthesis.speak(u);
  }, [anchorOff]);

  const stop = useCallback(() => {
    stopped.current = true;
    window.speechSynthesis?.cancel();
    anchorOff();
    setStatus("idle");
    setPos(0);
  }, [anchorOff]);

  const pause = useCallback(() => {
    window.speechSynthesis.pause();
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
    setStatus("paused");
  }, []);

  const resume = useCallback(() => {
    window.speechSynthesis.resume();
    anchorOn();
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    setStatus("playing");
  }, [anchorOn]);

  const unlock = useCallback(() => {
    if (!supported) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(""));
    anchorOn(); // 오디오 앵커도 제스처 안에서 시작해야 자동재생 정책에 안 막힌다
  }, [supported, anchorOn]);

  const speak = useCallback(
    (text: string, meta?: { title?: string; artist?: string }) => {
      if (!supported) return;
      const body = text.trim();
      if (!body) return;
      stopped.current = false;
      sentences.current = toSentences(body);
      idx.current = 0;
      setTotal(sentences.current.length);
      setPos(0);
      setStatus("playing");
      if ("mediaSession" in navigator) {
        try {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: meta?.title ?? "VNTG 읽어주기",
            artist: meta?.artist ?? "VNTG",
          });
          navigator.mediaSession.playbackState = "playing";
          navigator.mediaSession.setActionHandler("play", () => resume());
          navigator.mediaSession.setActionHandler("pause", () => pause());
          navigator.mediaSession.setActionHandler("stop", () => stop());
        } catch {
          /* 미지원 브라우저 — 없어도 낭독은 된다 */
        }
      }
      speakNext();
    },
    [supported, speakNext, resume, pause, stop],
  );

  /* 화면 유지 — 어떤 기기서든 확실히 안 끊기게 하는 마지막 안전판 */
  const setWake = useCallback(async (on: boolean) => {
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
  }, []);

  /* 화면을 떠나면 입을 다문다 — 다른 탭에서 계속 떠들면 그게 버그다 */
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
  }, [status, speakNext]);

  /* 화면이 다시 보이면: 풀린 wake lock 재획득 + 끊긴 낭독을 워치독보다 빨리 잇는다 */
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      if (keepAwake && !wakeLock.current) void setWake(true);
      const s = window.speechSynthesis;
      if (statusRef.current === "playing" && !s.speaking && !s.pending && !stopped.current) speakNext();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [keepAwake, setWake, speakNext]);

  return { supported, status, pos, total, rate, setRate, keepAwake, setWake, unlock, speak, pause, resume, stop };
}
