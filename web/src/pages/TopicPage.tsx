import { useEffect, useRef, useState } from "react";
import { api, type ChannelEntry, type FeedItem, type NewsFeed } from "../api";
import { TopicPulseBlock } from "../components/TopicPulse";
import { NewsPage } from "./NewsPage";
import { TelegramPage } from "./TelegramPage";
import { RefreshBar } from "../components/RefreshBar";
import { useTabActive } from "../tabActive";

/**
 * **지금의 화제** (2026-11-26 — 벤티지: "뉴스랑 텔레그램 동향이랑 합쳐가지고 재구성 해보자.
 * 두개가 따로 있을 필요가 없네 … 지금 화제가 가장 앞에 가고 이게 이제 지금의화제 메뉴가
 * 되는거지").
 *
 * ## 왜 둘이 따로 있으면 안 되나
 *
 * 뉴스와 채널은 **같은 사건을 다른 속도로** 말한다. 채널이 먼저 떠들고 뉴스가 받아 적는
 * 날이 있고, 공시가 먼저 뜨고 채널이 해석하는 날이 있다. 그런데 메뉴가 갈려 있으면
 * **어느 쪽이 먼저 말했는지**를 볼 수가 없다 — 오가는 사이 시각이 머릿속에서 섞인다.
 *
 * ## 차례가 곧 뜻이다
 *
 *   ① 지금의 화제   — 서버가 지은 한 문장. **「지금 뭐가 시끄러운가」가 먼저다**
 *   ② 지금          — 뉴스와 채널을 시각 하나로 섞은 줄. 「누가 먼저 말했나」가 보인다
 *   ③ 뉴스 / 텔레그램 — 파고들 때 쓰는 원래 화면 그대로
 *
 * 요약을 먼저 읽고 필요하면 내려가는 구조다. 예전에는 **파고드는 화면부터** 열어야 했다.
 *
 * ⚠️ 기존 두 페이지를 **그대로 끼워 넣는다**(복사본이 아니다). 두 벌로 두면 한쪽만
 * 고치는 날이 반드시 온다 — MAP 을 시황 대시보드에 넣을 때와 같은 판단이다.
 */

type Tab = "now" | "news" | "telegram";

const TABS: { key: Tab; label: string }[] = [
  { key: "now", label: "지금" },
  { key: "news", label: "뉴스·공시" },
  { key: "telegram", label: "텔레그램" },
];

/** 몇 분 전인지 — 「22:03」보다 「7분 전」이 빠르게 읽힌다 */
function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}시간 전` : `${Math.floor(h / 24)}일 전`;
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    : "";
}

const WINDOWS = [60, 180, 360] as const;

type Kind = "all" | "news" | "channel";

/**
 * **고른 방은 이 기기에 남는다** (2026-11-26 — 벤티지: "여기에 나오는 텔레그램 채널
 * 내가 고를 수 있게 해줘봐").
 *
 * 서버가 아니라 `localStorage` 인 것은 **27인치와 폰의 사정이 다르기** 때문이다.
 * 자리에 앉아 볼 때는 다 켜 두고, 폰에서는 두어 방만 보고 싶을 수 있다 — 사이드바
 * 접기·보드 설정과 같은 판단이다.
 *
 * 이름이 아니라 **id** 로 적는다. 방 이름은 운영자가 바꾸고(「(5분 딜레이)」가 붙고
 * 떨어진다), 이름으로 적어 두면 그날 고른 방이 조용히 풀린다.
 */
const ROOMS_KEY = "vntg.topic.rooms";

function loadRooms(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(ROOMS_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** 채널 한 줄의 방 열쇠 — id 가 없던 때의 글(예전 캐시)은 이름으로 떨어진다 */
function roomKey(i: FeedItem): string {
  return i.fromId || i.from;
}

function NowFeed() {
  const [minutes, setMinutes] = useState<number>(180);
  /*
   * **종류 필터** (2026-11-26 — 벤티지: "필터 좀 넣어줘 채널인지 텔레그램인지 뉴스인지
   * 그런거 종류별로 볼수있게"). 섞어 보는 것이 이 화면의 일이지만, 「채널만 182건」 같은
   * 날에는 뉴스 여덟 건이 묻힌다 — 그때 갈라 볼 수 있어야 한다.
   */
  const [kind, setKind] = useState<Kind>("all");
  /** 고른 방들 — 빈 배열이면 전부 본다. 종류와 **상관없이** 걸린다 */
  const [rooms, setRooms] = useState<string[]>(loadRooms);
  /** 뉴스 쪽 언론사 좁히기 — 여긴 하나만 고른다(매체가 수십 개라 겹쳐 고를 일이 없다) */
  const [press, setPress] = useState<string | null>(null);
  /** 방 고르는 줄을 폈나 — 기본은 접힘(폰에서 칩이 화면 절반을 먹는다) */
  const [pickOpen, setPickOpen] = useState(false);
  /** 조용한 방까지 다 펼쳐 보기 — 열 때 한 번만 구독 목록을 읽는다 */
  const [allRooms, setAllRooms] = useState<ChannelEntry[] | null>(null);
  const [openRooms, setOpenRooms] = useState(false);
  const [data, setData] = useState<NewsFeed | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const tabActive = useTabActive();
  /* 창을 바꾸며 빠르게 누르면 늦은 응답이 새 것을 덮는다 — 이 파일들의 공통 가드 */
  const seq = useRef(0);

  const load = () => {
    const my = ++seq.current;
    setLoading(true);
    api
      .newsFeed(minutes)
      .then((r) => {
        if (my !== seq.current) return;
        setData(r);
        setErr(null);
      })
      .catch((e: Error) => my === seq.current && setErr(e.message))
      .finally(() => my === seq.current && setLoading(false));
  };

  useEffect(() => {
    if (!tabActive) return;
    load();
    /* 채널 수집이 3~5분 주기라 그보다 자주 물어도 새 값이 없다 */
    const t = setInterval(load, 180_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minutes, tabActive]);

  /* 구독 목록은 「모든 채널」을 펼칠 때만 — 안 펼치면 조회가 늘지 않는다 */
  useEffect(() => {
    if (!openRooms || allRooms) return;
    api
      .channels()
      .then((r) => setAllRooms(r.channels))
      .catch(() => setAllRooms([]));
  }, [openRooms, allRooms]);

  const setRoomsSaved = (next: string[]) => {
    setRooms(next);
    try {
      localStorage.setItem(ROOMS_KEY, JSON.stringify(next));
    } catch {
      /* 사생활 모드 — 이번만 걸리고 안 남는다 */
    }
  };
  const toggleRoom = (id: string) =>
    setRoomsSaved(rooms.includes(id) ? rooms.filter((r) => r !== id) : [...rooms, id]);

  const all = data?.items ?? [];
  const picked = new Set(rooms);

  /** 이 시간창에 글이 있던 방 — 많이 떠든 순 */
  const seen = (() => {
    const m = new Map<string, { id: string; name: string; n: number }>();
    for (const i of all) {
      if (i.kind !== "channel") continue;
      const id = roomKey(i);
      const cur = m.get(id);
      if (cur) cur.n += 1;
      else m.set(id, { id, name: i.from, n: 1 });
    }
    return [...m.values()].sort((a, b) => b.n - a.n);
  })();

  /*
   * **고른 방이 조용하면 칩에서 사라진다** — 그러면 풀 방법이 없다. 그래서 이 창에
   * 글이 없어도 고른 방은 반드시 세운다. 「조용한 것」과 「없는 것」을 가르는 자리다.
   */
  const quietPicked = rooms
    .filter((id) => !seen.some((s) => s.id === id))
    .map((id) => ({
      id,
      name: allRooms?.find((c) => c.id === id)?.name ?? id,
      n: 0,
    }));

  /*
   * 접었을 때는 **떠든 방 열여섯 개**까지만. 구독 방이 일흔 개라 다 깔면 필터가 본문보다
   * 길어진다 — 폰에서는 글이 화면 아래로 밀려난다.
   *
   * 펼치면 ① 떠든 방 전부 ② 이 창엔 조용했던 나머지 구독 방을 **최근 글 순**으로 붙인다.
   * 가나다순이 아니라 최근 순인 것은, 몇 주째 조용한 방이 맨 앞에 와 봐야 소용이 없어서다.
   */
  const rest = openRooms
    ? (allRooms ?? [])
        .filter((c) => c.enabled !== false)
        .filter((c) => !seen.some((s) => s.id === c.id) && !rooms.includes(c.id))
        .sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""))
        .slice(0, 40)
        .map((c) => ({ id: c.id, name: c.name, n: 0 }))
    : [];

  const chips = [...(openRooms ? seen : seen.slice(0, 16)), ...quietPicked, ...rest];

  /* 방 고르기는 종류보다 **먼저** 건다 — 「전체」에서도 꺼 둔 방은 안 보여야 한다 */
  const byRoom = all.filter(
    (i) => i.kind !== "channel" || picked.size === 0 || picked.has(roomKey(i)),
  );
  const byKind = kind === "all" ? byRoom : byRoom.filter((i) => i.kind === kind);
  const shown = kind === "news" && press ? byKind.filter((i) => i.from === press) : byKind;

  const chShown = byRoom.filter((i) => i.kind === "channel").length;
  const chAll = data?.channelCount ?? 0;
  const newsAll = data?.newsCount ?? 0;

  /** 뉴스 언론사 칩 — 많이 쓴 순 여덟 */
  const presses = (() => {
    const m = new Map<string, number>();
    for (const i of all) if (i.kind === "news") m.set(i.from, (m.get(i.from) ?? 0) + 1);
    return [...m.entries()]
      .map(([name, n]) => ({ name, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 8);
  })();

  return (
    <>
      <RefreshBar onRefresh={load} loading={loading} updatedAt={data ? Date.parse(data.at) : null} />
      <div className="filter-row">
        {WINDOWS.map((m) => (
          <button key={m} className={`filter-btn ${minutes === m ? "active" : ""}`} onClick={() => setMinutes(m)}>
            {m < 60 ? `${m}분` : `${m / 60}시간`}
          </button>
        ))}
      </div>

      {/*
        종류 — 건수를 **버튼 안에** 적는다. 「조용한 것」과 「못 받은 것」을 가르는 수라
        따로 떨어뜨려 두면 안 읽힌다(그리고 폰에서 가로로 밀어낸다).
        방을 골라 둔 날의 텔레그램은 **보이는 수/온 수**로 적는다 — 걸러진 것을 숨기지 않는다.
      */}
      <div className="filter-row">
        {([
          { k: "all" as const, label: "전체", n: `${newsAll + chShown}${picked.size ? `/${newsAll + chAll}` : ""}` },
          { k: "news" as const, label: "뉴스", n: `${newsAll}` },
          { k: "channel" as const, label: "텔레그램", n: picked.size ? `${chShown}/${chAll}` : `${chAll}` },
        ]).map((b) => (
          <button
            key={b.k}
            className={`filter-btn ${kind === b.k ? "active" : ""}`}
            onClick={() => {
              setKind(b.k);
              setPress(null);
            }}
          >
            {b.label} {b.n}
          </button>
        ))}
      </div>

      {/*
        **방 고르기** — 눌러서 켜고 끈다(여러 개). 아무것도 안 고르면 전부 본다.
        뉴스만 볼 때는 안 보인다 — 그 화면에서는 할 일이 없는 줄이다.

        ⚠️ **접어 둔다.** 방이 여덟 개만 돼도 폰에서 칩이 일곱 줄로 꺾여, 필터가 화면
        절반을 먹고 정작 글은 아래로 밀려난다. 이 줄은 **가끔 손대는 것**이지 늘 보는
        것이 아니다 — 고른 게 있으면 아래 「…개 방만 보는 중」이 대신 말해 준다.
      */}
      {kind !== "news" && chips.length > 1 && !pickOpen && (
        <div className="filter-row">
          <button className={`filter-btn ${picked.size ? "active" : ""}`} onClick={() => setPickOpen(true)}>
            채널 고르기{picked.size ? ` · ${picked.size}개` : ""} ▾
          </button>
        </div>
      )}

      {kind !== "news" && chips.length > 1 && pickOpen && (
        <div className="filter-row nf-rooms">
          <button
            className={`filter-btn ${picked.size === 0 ? "active" : ""}`}
            onClick={() => setRoomsSaved([])}
          >
            전부
          </button>
          {chips.map((c) => (
            <button
              key={c.id}
              className={`filter-btn ${picked.has(c.id) ? "active" : ""}`}
              onClick={() => toggleRoom(c.id)}
              title={c.n === 0 ? `${c.name} — 이 시간창에는 글이 없습니다` : `${c.name} ${c.n}건`}
            >
              {c.name} {c.n === 0 ? "·" : c.n}
            </button>
          ))}
          <button className="filter-btn" onClick={() => setOpenRooms((v) => !v)}>
            {openRooms ? "떠든 방만" : "모든 채널"}
          </button>
          <button
            className="filter-btn"
            onClick={() => {
              setPickOpen(false);
              setOpenRooms(false);
            }}
          >
            접기 ▴
          </button>
        </div>
      )}

      {/*
        고른 게 있으면 **그 사실을 글로** 둔다. 기억해 두는 설정이라, 며칠 뒤에 열어
        「왜 이 방 글이 안 보이지」 하는 일이 없어야 한다.
      */}
      {picked.size > 0 && (
        <div className="page-note">
          텔레그램은 고른 <b>{picked.size}개 방</b>만 보는 중 — 온 {chAll}건 중 {chShown}건.{" "}
          <button className="link-btn" onClick={() => setRoomsSaved([])}>
            전부 보기
          </button>
        </div>
      )}

      {/* 언론사 — 뉴스만 볼 때. 매체가 수십 개라 하나씩 좁혀 본다 */}
      {kind === "news" && presses.length > 1 && (
        <div className="filter-row">
          <button className={`filter-btn ${press === null ? "active" : ""}`} onClick={() => setPress(null)}>
            전부
          </button>
          {presses.map((s) => (
            <button
              key={s.name}
              className={`filter-btn ${press === s.name ? "active" : ""}`}
              onClick={() => setPress(s.name)}
            >
              {s.name} {s.n}
            </button>
          ))}
        </div>
      )}

      {err && <div className="error-banner">{err}</div>}
      {data && shown.length === 0 && !loading && (
        <div className="page-note">
          {picked.size > 0 && chAll > 0 ? (
            <>
              고른 방에서는 이 시간창에 올라온 글이 없습니다. 위의 <b>전부 보기</b>로 풀거나
              창을 넓혀 보세요.
            </>
          ) : (
            <>
              그 시간 안에는 뉴스도 채널 글도 없습니다. 창을 넓혀 보세요 — <b>조용한 것</b>과
              <b> 못 받은 것</b>은 다르므로, 위의 「뉴스 0 · 텔레그램 0」이 그 둘을 가릅니다.
            </>
          )}
        </div>
      )}

      <div className="nf">
        {shown.map((it: FeedItem, i) => (
          <a
            className={`nf-row ${it.kind}`}
            key={`${it.kind}${it.at}${i}`}
            href={it.link || undefined}
            target="_blank"
            rel="noreferrer"
          >
            <span className="nf-t">
              <b>{hhmm(it.at)}</b>
              <em className="pt-n">{ago(it.at)}</em>
            </span>
            <span className="nf-k">{it.kind === "news" ? "뉴스" : "채널"}</span>
            <span className="nf-b">
              <b className="nf-title">{it.title}</b>
              <em className="nf-from pt-n">
                {it.from}
                {it.category ? ` · ${it.category}` : ""}
              </em>
              {it.body && <span className="nf-body pt-n">{it.body}</span>}
            </span>
          </a>
        ))}
      </div>
    </>
  );
}

export function TopicPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [tab, setTab] = useState<Tab>("now");

  return (
    <div>
      {/*
        **화제가 맨 앞이다.** 탭 밖에 둔 것은 일부러다 — 어느 탭을 보고 있든 「지금 뭐가
        시끄러운가」는 같은 물음이라, 탭을 옮길 때마다 사라졌다 나타나면 안 된다.
      */}
      <TopicPulseBlock window="now" variant="full" onSelectStock={onSelectStock} />

      <div className="filter-row">
        {TABS.map((t) => (
          <button key={t.key} className={`filter-btn ${tab === t.key ? "active" : ""}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "now" && <NowFeed />}
      {/* 원래 화면을 **그대로** 끼운다 — 복사본을 만들면 한쪽만 고치는 날이 온다 */}
      {tab === "news" && <NewsPage onSelectStock={onSelectStock} />}
      {tab === "telegram" && <TelegramPage onSelectStock={onSelectStock} />}
    </div>
  );
}
