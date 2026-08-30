import type { CalendarEvent, EventKind } from "./calendar.js";

/**
 * 외부 일정 가져오기 — ICS(iCalendar)와 CSV를 파싱한다.
 *
 * 구글 캘린더는 OAuth 대신 "비공개 주소(ICAL)"를 쓴다. 읽기 전용이지만
 * 설정이 URL 하나로 끝나고 토큰 갱신 같은 게 없어서 개인용으로는 이쪽이 낫다.
 * 라이브러리를 추가하지 않고 필요한 필드만 직접 파싱한다.
 */

/** ICS는 75옥텟마다 줄을 접는다(다음 줄이 공백/탭으로 시작). 먼저 펴야 파싱된다. */
function unfold(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** ICS 이스케이프 해제 */
function unescapeIcs(v: string): string {
  return v
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

/** DTSTART 값을 날짜/시각으로. 종일 일정은 시각이 없다. */
function parseDt(raw: string, params: string): { date: string; time?: string } | null {
  const v = raw.trim();
  // 20260820 (종일)
  if (/^\d{8}$/.test(v)) {
    return { date: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` };
  }
  // 20260820T030000Z 또는 20260820T120000
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  if (z) {
    // UTC로 온 값은 한국시간으로 옮겨서 보여준다
    const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi);
    const kst = new Date(utc + 9 * 3600_000);
    return {
      date: kst.toISOString().slice(0, 10),
      time: kst.toISOString().slice(11, 16),
    };
  }
  // TZID가 붙은 로컬 시각은 그대로 쓴다 (대개 캘린더 소유자의 시간대)
  void params;
  return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}` };
}

export interface ImportedEvent extends Omit<CalendarEvent, "id"> {
  source: string;
}

/** ICS 텍스트에서 VEVENT를 뽑아 우리 형식으로 */
export function parseIcs(text: string, source: string, kind: EventKind = "personal"): ImportedEvent[] {
  const lines = unfold(text);
  const out: ImportedEvent[] = [];

  let cur: {
    date?: string;
    time?: string;
    endTime?: string;
    endDate?: string;
    srcKey?: string;
    title?: string;
    memo?: string;
  } | null = null;
  for (const line of lines) {
    if (line.startsWith("BEGIN:VEVENT")) {
      cur = {};
      continue;
    }
    if (line.startsWith("END:VEVENT")) {
      if (cur?.date && cur.title) {
        out.push({
          date: cur.date,
          time: cur.time,
          /*
           * 끝나는 시각은 **같은 날일 때만** 쓴다 (2026-08-28). 자정을 넘기는 일정의
           * DTEND 는 다음 날이라 그대로 넣으면 「22:00~01:00」처럼 거꾸로 보인다.
           */
          endTime: cur.time && cur.endDate === cur.date ? cur.endTime : undefined,
          title: cur.title,
          memo: cur.memo,
          kind,
          srcKey: cur.srcKey,
          source,
        });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;

    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const left = line.slice(0, sep);
    const value = line.slice(sep + 1);
    const [name, ...params] = left.split(";");

    if (name === "DTSTART") {
      const p = parseDt(value, params.join(";"));
      if (p) {
        cur.date = p.date;
        cur.time = p.time;
      }
    } else if (name === "DTEND") {
      const p = parseDt(value, params.join(";"));
      if (p) {
        cur.endDate = p.date;
        cur.endTime = p.time;
      }
    } else if (name === "UID") {
      /*
       * 원본 쪽 고유 열쇠 (2026-08-30).
       *
       * 이게 있어야 **내가 고친 일정을 동기화가 덮어쓰지 않는다.** 고친 일정을 남겨
       * 두면 다음 동기화에 원본이 다시 들어와 둘이 되는데, 열쇠가 같으면 「이미
       * 고쳐서 갖고 있는 것」임을 알고 건너뛴다.
       */
      cur.srcKey = value.trim();
    } else if (name === "SUMMARY") {
      cur.title = unescapeIcs(value);
    } else if (name === "DESCRIPTION") {
      const memo = unescapeIcs(value);
      // 설명이 너무 길면 잘라서 넣는다 (캘린더 화면이 깨지지 않게)
      cur.memo = memo.length > 120 ? `${memo.slice(0, 120)}…` : memo;
    }
  }
  return out;
}

const KIND_ALIAS: Record<string, EventKind> = {
  증시: "market",
  market: "market",
  실적: "earnings",
  earnings: "earnings",
  휴장: "holiday",
  holiday: "holiday",
  개인: "personal",
  personal: "personal",
  이벤트: "event",
  행사: "event",
  event: "event",
  학회: "conference",
  컨퍼런스: "conference",
  conference: "conference",
  /* 2026-08-30 — 리서치 캘린더 양식의 분류를 그대로 받는다 */
  공개: "indicator",
  지표: "indicator",
  발표: "indicator",
  indicator: "indicator",
  회의: "meeting",
  meeting: "meeting",
  채권: "bond",
  발행: "bond",
  입찰: "bond",
  bond: "bond",
  파생: "deriv",
  만기: "deriv",
  deriv: "deriv",
  주간: "weekly",
  주간핵심: "weekly",
  weekly: "weekly",
};

/**
 * 시간 칸을 읽는다 — `09:00` 또는 `09:00~10:00` (`-`, `–` 도 됨).
 *
 * 열을 새로 만들지 않고 **한 칸 안에서 범위를 받는다.** 열을 늘리면 이미 쓰던
 * `날짜,제목,종류,시간,메모` 파일이 메모 자리를 잃는다.
 */
function parseTimeCell(raw: string | undefined): { time?: string; endTime?: string } {
  const v = (raw ?? "").trim();
  if (!v) return {};
  const [a, b] = v.split(/\s*[~\-–]\s*/);
  const ok = (s: string | undefined) => (s && /^\d{1,2}:\d{2}$/.test(s) ? s : undefined);
  return { time: ok(a), endTime: ok(a) ? ok(b) : undefined };
}

/**
 * CSV 파싱. 헤더는 있어도 없어도 되고, 열 순서는
 * date,title,kind,time,memo 를 기본으로 본다.
 */
/**
 * CSV 한 줄을 칸으로 가른다.
 *
 * ## ⚠️ 예전 방식은 빈 칸을 삼켰다
 *
 * `row.match(/("[^"]*"|[^,]+)/g)` 로 뽑고 있었는데, 이 정규식은 **연속된 쉼표 사이의
 * 빈 칸을 아예 안 만든다.** 그래서 `날짜,제목,공개,21:30,,미국,` 이 여섯 칸이 아니라
 * 다섯 칸으로 읽히고 **그 뒤가 통째로 한 칸씩 밀린다** — 나라 자리에 「★」가 들어가는
 * 식이다. 칸을 하나 더할 때마다 이 문제가 커진다.
 *
 * 실측(2026-08-30): 국가 칸을 더하자마자 두 줄이 어긋났다.
 *
 * 그래서 한 글자씩 훑으며 **쉼표를 만나면 그 자리에서 칸을 닫는다.** 따옴표 안의
 * 쉼표는 지나치고, `""` 는 따옴표 한 개로 푼다(엑셀이 그렇게 내보낸다).
 */
function splitRow(row: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < row.length; i += 1) {
    const c = row[i];
    if (c === '"') {
      if (inQuote && row[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuote = !inQuote;
      }
    } else if (c === "," && !inQuote) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur.trim());
  return out;
}

export function parseCsv(text: string, source: string, defaultKind: EventKind = "personal"): ImportedEvent[] {
  const rows = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean);

  const out: ImportedEvent[] = [];
  for (const row of rows) {
    /*
     * ⚠️ **주석 줄을 명시적으로 건너뛴다.**
     *
     * 양식 파일은 「`#` 로 시작하는 줄은 설명」이라고 적어 두고 있었는데, 파서는
     * 그걸 모르고 **날짜 자리에 8자리 숫자가 없기를** 바라고 있었다. 그런데 설명에
     * 예시를 적으면(「빈 칸도 쉼표로 — 2026-09-04,고용보고서,…」) 거기 날짜가 들어
     * 있어 **설명이 일정으로 등록된다.** 실측에서 예시 열 줄이 열한 줄로 읽혔다.
     *
     * 규칙을 적어 놨으면 그 규칙대로 읽어야 한다.
     */
    if (row.startsWith("#")) continue;

    const cells = splitRow(row);
    if (cells.length < 2) continue;

    /*
     * 열 순서: 날짜,제목,종류,시간,메모,국가,대표
     *
     * ⚠️ **예전 파일과 섞여야 한다.** 여섯째 칸이 옛 양식에서는 종료 시각이었다.
     * 그래서 그 칸이 `HH:mm` 꼴이면 종료 시각으로, 아니면 국가로 읽는다 — 옛 파일을
     * 다시 올렸을 때 나라 칸에 「10:30」이 들어가는 일이 없어야 한다.
     */
    const [rawDate, title, rawKind, rawTime, memo, rawSixth, rawFlag] = cells;
    const sixthIsTime = /^\d{1,2}:\d{2}$/.test((rawSixth ?? "").trim());
    const rawEnd = sixthIsTime ? rawSixth : undefined;
    const rawCountry = sixthIsTime ? undefined : rawSixth;
    // 헤더 줄 건너뛰기
    if (/^(date|날짜)$/i.test(rawDate)) continue;

    // 2026-08-20 / 2026.08.20 / 20260820 모두 허용
    const digits = rawDate.replace(/[^\d]/g, "");
    if (digits.length !== 8) continue;
    const date = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    if (!title) continue;

    const { time, endTime } = parseTimeCell(rawTime);
    out.push({
      date,
      title,
      kind: KIND_ALIAS[(rawKind ?? "").toLowerCase()] ?? defaultKind,
      time,
      // 여섯째 칸을 종료 시각으로도 받는다 — 시간 칸에 `~` 로 적는 쪽이 기본
      endTime: endTime ?? parseTimeCell(rawEnd).time,
      memo: memo || undefined,
      country: (rawCountry ?? "").trim() || undefined,
      /* 「대표」「★」「Y」 무엇으로 적어도 받는다 — 사람이 손으로 채우는 칸이다 */
      headline: /^(대표|핵심|★|\*|y|yes|true|1)$/i.test((rawFlag ?? "").trim()) || undefined,
      /* 표에는 UID 가 없으니 「날짜|제목」을 열쇠로 쓴다 — 같은 파일을 다시 올려도 짝이 맞는다 */
      srcKey: `${date}|${title}`,
      source,
    });
  }
  return out;
}

/** 원격 ICS(구글 캘린더 비공개 주소 등)를 받아온다 */
export async function fetchIcs(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) throw new Error("http(s) 주소만 사용할 수 있습니다.");
  const res = await fetch(url, { headers: { "User-Agent": "VNTG-HTS/1.0" } });
  if (!res.ok) throw new Error(`캘린더 주소 조회 실패: HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes("BEGIN:VCALENDAR")) {
    throw new Error("iCal 형식이 아닙니다. 구글 캘린더의 '비공개 주소(ICAL)'인지 확인하세요.");
  }
  return text;
}
