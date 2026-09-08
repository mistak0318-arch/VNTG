/**
 * **이 값이 지금 움직이는 값인가** — 시장별 개장 판정 (2026-09-08).
 *
 * 벤티지: "시황 대시보드에 나와 있는 것들, 장중인지 아닌지 표시 좀 해줄 수 있어?
 * 장이 시작된 건지 끝난 건지를 모르겠네."
 *
 * 한 화면에 국내·미국·아시아·외환·원자재·암호화폐가 같이 있는데, 숫자만 보면 **지금
 * 뛰는 값**과 **몇 시간 전에 끝난 값**이 생김새가 똑같다. 마감된 시장의 +1.2% 는 어제
 * 소식이고 장중의 +1.2% 는 지금 일어나는 일인데, 그 둘을 구별할 방법이 화면에 없었다.
 *
 * ⚠️ **시계로만 센다.** 휴장일은 모른다 — 그래서 「열림」이 떠도 값이 안 움직일 수 있다.
 * 국내장만은 서버가 실제 상태를 주므로([useMarketOpen](./useLive.ts)) 그쪽을 쓴다.
 * 시각 계산은 브라우저의 시간대 데이터에 맡긴다(서머타임을 직접 세지 않는다).
 */

export type SessionState = "open" | "pre" | "after" | "closed";

export interface Session {
  state: SessionState;
  /** 화면에 찍을 짧은 말 */
  label: string;
  /** 왜 이렇게 봤나 — 툴팁 */
  hint: string;
}

/** 어느 시간대의 요일·분인가 */
function zoned(tz: string, now: Date): { day: number; mins: number } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(f.formatToParts(now).map((p) => [p.type, p.value]));
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    day: days.indexOf(String(parts.weekday)),
    // 자정이 "24" 로 오는 환경이 있다
    mins: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
  };
}

const at = (h: number, m = 0): number => h * 60 + m;

/**
 * 시장 갈래.
 *
 * `kr` 은 서버 판정을 쓰므로 여기서 안 센다 — [SessionBadge](./components/SessionBadge.tsx) 가 가른다.
 */
export type MarketKind =
  | "krNight" // 코스피 야간선물
  | "us" // 미국 정규장
  | "usFut" // CME 지수선물
  | "asia" // 도쿄·홍콩 (묶음 표는 둘 중 하나라도 열렸으면 열림)
  | "jp" // 도쿄
  | "hk" // 홍콩
  | "fx" // 외환
  | "commodity" // CME 원자재
  | "crypto"; // 24시간

/**
 * CME 가 도는가 — 일요일 18:00 ET 개장, 금요일 17:00 ET 마감, **매일 17:00~18:00 ET 는 쉰다**.
 * 지수선물·원자재·외환이 다 이 시간표를 쓴다(상품마다 몇 분씩 다르지만 그 차이는 화면에 뜻이 없다).
 */
function cme(now: Date): Session {
  const { day, mins } = zoned("America/New_York", now);
  const closed = { state: "closed" as const, label: "휴장", hint: "CME 주말 휴장 — 일요일 저녁(한국 월요일 아침)에 다시 엽니다" };
  if (day === 6) return closed; // 토요일 통째로
  if (day === 0 && mins < at(18)) return closed; // 일요일 개장 전
  if (day === 5 && mins >= at(17)) return closed; // 금요일 마감 후
  if (mins >= at(17) && mins < at(18)) {
    return { state: "closed", label: "일일 휴식", hint: "CME 는 매일 미 동부 17~18시(한국 오전 6~7시)에 한 시간 쉽니다" };
  }
  return { state: "open", label: "거래 중", hint: "CME 는 거의 24시간 돕니다 — 이 값은 지금 움직이는 값입니다" };
}

/** 한 시장의 지금 세션 */
export function sessionOf(kind: MarketKind, now: Date = new Date()): Session {
  if (kind === "crypto") {
    return { state: "open", label: "24시간", hint: "암호화폐는 쉬지 않습니다" };
  }

  if (kind === "usFut" || kind === "commodity" || kind === "fx") {
    const s = cme(now);
    if (kind === "fx" && s.state === "open") {
      return { state: "open", label: "거래 중", hint: "외환은 주중 24시간 돕니다 — 이 값은 지금 움직이는 값입니다" };
    }
    if (kind === "fx" && s.state === "closed") {
      return { state: "closed", label: "휴장", hint: "외환은 주말에 쉽니다 — 금요일 마지막 값입니다" };
    }
    return s;
  }

  if (kind === "us") {
    const { day, mins } = zoned("America/New_York", now);
    if (day === 0 || day === 6) {
      return { state: "closed", label: "휴장", hint: "미국 주말 휴장 — 금요일 종가입니다" };
    }
    if (mins >= at(9, 30) && mins < at(16)) {
      return { state: "open", label: "정규장", hint: "미국 정규장(한국 밤 10:30~새벽 5:00, 서머타임 기준) — 지금 움직입니다" };
    }
    if (mins >= at(4) && mins < at(9, 30)) {
      return { state: "pre", label: "프리장", hint: "미국 프리마켓 — 정규장 전 시간외입니다" };
    }
    if (mins >= at(16) && mins < at(20)) {
      return { state: "after", label: "애프터장", hint: "미국 애프터마켓 — 정규장 뒤 시간외입니다" };
    }
    return { state: "closed", label: "마감", hint: "미국장이 닫혀 있습니다 — 마지막 세션의 값입니다" };
  }

  if (kind === "krNight") {
    /*
     * 코스피 야간선물 — 18:00~다음날 05:00 KST. 자정을 넘으므로 **요일 판정이 까다롭다**:
     * 토요일 새벽 05:00 까지는 금요일 밤 세션이라 열려 있고, 일요일·월요일 새벽은 닫혀 있다.
     */
    const { day, mins } = zoned("Asia/Seoul", now);
    const evening = mins >= at(18);
    const dawn = mins < at(5);
    const open = (evening && day >= 1 && day <= 5) || (dawn && day >= 2 && day <= 6);
    return open
      ? { state: "open", label: "야간 거래 중", hint: "코스피 야간선물 18:00~05:00 — 지금 움직입니다" }
      : { state: "closed", label: "마감", hint: "야간선물은 18:00 에 엽니다 — 지금 값은 직전 세션의 마지막 값입니다" };
  }

  if (kind === "asia") {
    /*
     * 「아시아」 묶음엔 닛케이와 항셍이 같이 있다. 둘은 점심시간까지 조금씩 다른데,
     * 묶음 머리에 붙는 표는 **한 줄**이라 둘 중 하나라도 열렸으면 열린 것으로 본다.
     * 정확한 시간표는 툴팁에 적는다 — 표 하나로 두 시장을 말하려면 그 정도가 정직하다.
     */
    const jp = sessionOf("jp", now);
    const hk = sessionOf("hk", now);
    const open = jp.state === "open" || hk.state === "open";
    return {
      state: open ? "open" : "closed",
      label: open ? "거래 중" : "마감",
      hint: `도쿄 ${jp.label} (09:00~15:30, 점심 11:30~12:30) · 홍콩 ${hk.label} (한국 10:30~17:00, 점심 13:00~14:00)`,
    };
  }

  if (kind === "jp") {
    const { day, mins } = zoned("Asia/Tokyo", now);
    if (day === 0 || day === 6) return { state: "closed", label: "휴장", hint: "도쿄 주말 휴장" };
    if (mins >= at(9) && mins < at(11, 30)) return { state: "open", label: "전장", hint: "도쿄 전장 09:00~11:30 (한국과 같은 시각)" };
    if (mins >= at(11, 30) && mins < at(12, 30)) return { state: "closed", label: "점심 휴장", hint: "도쿄는 11:30~12:30 에 쉽니다" };
    if (mins >= at(12, 30) && mins < at(15, 30)) return { state: "open", label: "후장", hint: "도쿄 후장 12:30~15:30 (한국과 같은 시각)" };
    return { state: "closed", label: "마감", hint: "도쿄장이 닫혀 있습니다 — 종가입니다" };
  }

  // hk
  const { day, mins } = zoned("Asia/Hong_Kong", now);
  if (day === 0 || day === 6) return { state: "closed", label: "휴장", hint: "홍콩 주말 휴장" };
  if (mins >= at(9, 30) && mins < at(12)) return { state: "open", label: "전장", hint: "홍콩 전장 09:30~12:00 (한국 10:30~13:00)" };
  if (mins >= at(12) && mins < at(13)) return { state: "closed", label: "점심 휴장", hint: "홍콩은 12:00~13:00 에 쉽니다" };
  if (mins >= at(13) && mins < at(16)) return { state: "open", label: "후장", hint: "홍콩 후장 13:00~16:00 (한국 14:00~17:00)" };
  return { state: "closed", label: "마감", hint: "홍콩장이 닫혀 있습니다 — 종가입니다" };
}

/**
 * 글로벌 판의 묶음 이름 → 시장 갈래.
 *
 * 서버가 주는 `group` 을 그대로 받는다([globalMarket.ts](../../server/src/globalMarket.ts)).
 * 모르는 묶음이면 `null` — 그때는 표를 안 붙인다. 「모르면 아무 말도 안 하는 쪽」이 맞다.
 */
export function kindOfGroup(group: string): MarketKind | null {
  if (/야간선물/.test(group)) return "krNight";
  if (/환율/.test(group)) return "fx";
  if (/미국 지수선물|지수선물/.test(group)) return "usFut";
  if (/아시아/.test(group)) return "asia";
  if (/원자재/.test(group)) return "commodity";
  if (/암호화폐/.test(group)) return "crypto";
  return null;
}
