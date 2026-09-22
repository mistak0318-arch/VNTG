import { useCallback, useEffect, useState } from "react";
import { removePref, setPref } from "./prefs";

/**
 * 최근 본 종목.
 *
 * 종목을 볼 때는 몇 개를 오가며 비교하게 되는데, 그때마다 이름을 다시 치는 게 일이다.
 * 검색 결과에서 고른 것을 기억해 두고 바로 누를 수 있게 한다.
 *
 * 처음엔 localStorage 에만 뒀다("기기마다 보는 종목이 달라도 자연스럽다"). **2026-09-23 전역이 됐다** —
 * 벤티지: "어떤 기기에서 조회한 거든 최근 조회 내역에 뜰수 있도록". `prefs.ts` 의 LOCAL_ONLY 에서 빼서
 * `setPref` 가 서버에 올리고, 여기서는 두 가지를 더 한다:
 *   1. **읽을 때 서버 것과 합친다** (`syncFromServer`) — 앱이 뜰 때 한 번 받는 prefs 로는 다른 기기가
 *      그 뒤에 본 종목이 새로고침 전엔 안 보인다. 훅이 마운트될 때·탭이 다시 보일 때 합친다.
 *   2. **쌓을 때도 합친다** — 목록이 통째로 한 키라 나중에 쓴 기기가 앞 기기 것을 덮는다. 로컬에 먼저
 *      적고(화면은 바로), 서버 것을 받아 합친 뒤 다시 올린다. 합치기는 코드로 합집합, 시각은 최신.
 */

const KEY = "vntg.recent.stocks.v1";
/*
 * 12 → 30 (2026-09-22). 시세분석에 「최근조회」 탭이 생기면서 **표로도 보게 됐다** — 12줄은
 * 드롭다운에는 맞지만 표로는 얇다. 드롭다운 쪽은 각자 `slice` 로 짧게 자른다(길어지면 화면을
 * 가린다). 코드+이름+시각 30개라 localStorage 로도 가볍다.
 */
const MAX = 30;
/** 검색 드롭다운처럼 **좁은 자리**에서 보여 줄 개수 — 표(최근조회 탭)는 전부 쓴다 */
export const RECENT_COMPACT = 10;

export interface RecentStock {
  code: string;
  name: string;
  /** 마지막으로 본 시각 */
  at: number;
}

/**
 * **직전에 보던 종목** (2026-09-04) — 훅을 안 쓰고 한 번만 꺼내 보는 자리용.
 *
 * 벤티지: "주문 메뉴 진입할 때 직전에 보고 있던 주식을 바로 보여줬으면 좋겠어.
 * 매번 검색해야 돼서 불편." 주문 폼은 첫 렌더에 초기값을 정해야 해서 훅의 비동기
 * 갱신(useEffect)으로는 늦다 — 빈 칸이 한 번 그려지고 나서 채워진다.
 */
export function latestStock(): RecentStock | null {
  return read()[0] ?? null;
}

/**
 * **훅 없이 쌓는다** (2026-09-22 — 벤티지: "시세조회 다른 탭에서 삼성전기 조회하고 나서 최근조회
 * 탭 가서 보는데 삼성전기가 안뜨네?").
 *
 * 그때까지 `push` 는 **검색창에서 고를 때만** 불렸다. 시세분석 표에서 종목을 눌러 상세를 여는
 * 길에는 없어서, 표로 보던 종목은 최근 목록에 영영 안 쌓였다 — 「최근조회」 탭을 붙이고 나서야
 * 드러난 구멍이다(그전에는 검색 드롭다운에서만 보던 목록이라 눈에 안 띄었다).
 *
 * 고치는 자리는 **상세를 여는 단 하나의 문**(`App.tsx` 의 `onSelectStock`)이다. 거기 하나면
 * 시세분석·전광판·주도주·뉴스·관심종목이 전부 따라온다.
 *
 * ⚠️ 훅(`useRecentStocks`)이 아니라 함수다. App 최상위에 훅을 달면 종목을 누를 때마다 목록
 * 상태가 바뀌어 **앱 전체가 다시 그려진다.** 여기서는 쌓기만 하고, 보는 쪽이 storage 사건으로 받는다.
 */
export function pushRecent(code: string, name: string): void {
  /* 이름이 코드뿐이면 안 남긴다 — 목록에 「005930 005930」 같은 줄이 생긴다 (StockAnalysisPage 와 같은 규칙) */
  if (!code || !name || name === code) return;
  const next = [{ code, name, at: Date.now() }, ...read().filter((r) => r.code !== code)].slice(0, MAX);
  write(next);
  /* 서버 것과 합쳐 다시 올린다 — 다른 기기가 그새 본 종목을 덮지 않게 */
  void syncFromServer(true);
}

function parse(raw: string | null): RecentStock[] {
  try {
    const arr = JSON.parse(raw ?? "[]") as RecentStock[];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((r) => r && typeof r.code === "string" && typeof r.name === "string")
      .map((r) => ({ code: r.code, name: r.name, at: Number(r.at) || 0 }))
      .slice(0, MAX);
  } catch {
    return [];
  }
}

function read(): RecentStock[] {
  try {
    return parse(localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

function write(next: RecentStock[]): void {
  try {
    setPref(KEY, JSON.stringify(next));
    window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
  } catch {
    /* 저장 못 해도 화면은 그대로 뜬다 */
  }
}

/*
 * 이 기기에서 **지운 것**의 묘비 — 지운 직후 서버와 합치면(서버엔 600ms 뒤에야 올라간다) 지운 줄이
 * 되살아난다. 지운 시각보다 먼저 본 기록은 서버 것이라도 안 받는다. 그 뒤에 다른 기기가 다시 보면 돌아온다.
 */
const tomb = new Map<string, number>();
let clearedAt = 0;

/** 두 목록의 합집합 — 같은 코드는 최신 시각 하나. 최신순 MAX 개 */
function merge(a: RecentStock[], b: RecentStock[]): RecentStock[] {
  const by = new Map<string, RecentStock>();
  for (const r of [...a, ...b]) {
    if (r.at <= clearedAt || r.at <= (tomb.get(r.code) ?? 0)) continue;
    const cur = by.get(r.code);
    if (!cur || r.at > cur.at) by.set(r.code, r);
  }
  return [...by.values()].sort((x, y) => y.at - x.at).slice(0, MAX);
}

const same = (a: RecentStock[], b: RecentStock[]) =>
  a.length === b.length && a.every((r, i) => r.code === b[i].code && r.at === b[i].at);

let syncing: Promise<void> | null = null;
let lastSync = 0;

/**
 * 서버 사본과 합친다. 로컬과 서버가 다르면 합친 것을 로컬에 적고(화면이 따라온다) 서버에도 올린다.
 * 서버를 못 읽으면 아무 일도 없다 — 이 기기 목록으로 그대로 간다. 겹쳐 부르면 한 번만 돌고,
 * 훅이 여럿 마운트돼도(검색창·시세분석) 3초 안엔 한 번만 묻는다. `force` 는 쌓을 때 — 그건 늘 합친다.
 */
export function syncFromServer(force = false): Promise<void> {
  if (syncing) return syncing;
  if (!force && Date.now() - lastSync < 3000) return Promise.resolve();
  lastSync = Date.now();
  syncing = (async () => {
    try {
      const res = await fetch("/api/settings/ui");
      if (!res.ok) return;
      const body = (await res.json()) as { values?: Record<string, string> };
      const remote = parse(body.values?.[KEY] ?? null);
      const local = read();
      const merged = merge(local, remote);
      if (!same(merged, local)) write(merged);
      else if (!same(merged, remote)) write(merged); // 서버만 낡았다 — 올려서 맞춘다
    } catch {
      /* 서버가 없어도 목록은 이 기기 것으로 뜬다 */
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

export function useRecentStocks() {
  const [recent, setRecent] = useState<RecentStock[]>([]);

  useEffect(() => {
    setRecent(read());
    // 다른 화면에서 종목을 보면 이쪽도 따라간다
    const onChange = (e: StorageEvent) => {
      if (e.key === KEY) setRecent(read());
    };
    window.addEventListener("storage", onChange);
    /* 다른 기기가 본 것 — 마운트될 때, 그리고 탭이 다시 보일 때 서버와 합친다 (2026-09-23) */
    void syncFromServer();
    const onVisible = () => {
      if (document.visibilityState === "visible") void syncFromServer();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("storage", onChange);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  /** 종목을 봤다고 알린다. 같은 종목이면 맨 앞으로 올린다 */
  const push = useCallback((code: string, name: string) => {
    if (!code || !name) return;
    const next = [{ code, name, at: Date.now() }, ...read().filter((r) => r.code !== code)].slice(
      0,
      MAX,
    );
    setRecent(next);
    write(next);
    void syncFromServer(true);
  }, []);

  /* 지우기 — 묘비를 남기고(`merge` 가 되살리지 않게) 로컬을 적어 올린다 */
  const remove = useCallback((code: string) => {
    tomb.set(code, Date.now());
    const next = read().filter((r) => r.code !== code);
    setRecent(next);
    write(next);
  }, []);

  const clear = useCallback(() => {
    clearedAt = Date.now();
    setRecent([]);
    try {
      removePref(KEY);
      window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    } catch {
      /* 무시 */
    }
  }, []);

  return { recent, push, remove, clear };
}
