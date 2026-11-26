import { useEffect, useRef, useState } from "react";
import { api, type FeedItem, type NewsFeed } from "../api";
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

function NowFeed() {
  const [minutes, setMinutes] = useState<number>(180);
  /*
   * **종류 필터** (2026-11-26 — 벤티지: "필터 좀 넣어줘 채널인지 텔레그램인지 뉴스인지
   * 그런거 종류별로 볼수있게"). 섞어 보는 것이 이 화면의 일이지만, 「채널만 182건」 같은
   * 날에는 뉴스 여덟 건이 묻힌다 — 그때 갈라 볼 수 있어야 한다.
   */
  const [kind, setKind] = useState<Kind>("all");
  /** 방·매체로 더 좁히기 — 한 방이 쏟아내는 날이 있다 */
  const [from, setFrom] = useState<string | null>(null);
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

  const all = data?.items ?? [];
  const byKind = kind === "all" ? all : all.filter((i) => i.kind === kind);
  /* 많이 떠든 순 여덟 — 적게 뜬 곳까지 칩으로 깔면 필터가 본문보다 길어진다 */
  const sources = (() => {
    const m = new Map<string, number>();
    for (const i of byKind) m.set(i.from, (m.get(i.from) ?? 0) + 1);
    return [...m.entries()]
      .map(([name, n]) => ({ name, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 8);
  })();
  const shown = from ? byKind.filter((i) => i.from === from) : byKind;

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
      */}
      <div className="filter-row">
        {([
          { k: "all" as const, label: "전체", n: (data?.newsCount ?? 0) + (data?.channelCount ?? 0) },
          { k: "news" as const, label: "뉴스", n: data?.newsCount ?? 0 },
          { k: "channel" as const, label: "텔레그램", n: data?.channelCount ?? 0 },
        ]).map((b) => (
          <button
            key={b.k}
            className={`filter-btn ${kind === b.k ? "active" : ""}`}
            onClick={() => {
              setKind(b.k);
              setFrom(null);
            }}
          >
            {b.label} {b.n}
          </button>
        ))}
      </div>

      {/*
        방·매체 — 종류를 고른 뒤에만 보인다. 전체에서 한꺼번에 띄우면 칩이 수십 개가 되어
        **필터가 본문보다 길어진다.** 많이 떠든 순 여덟 개까지.
      */}
      {kind !== "all" && sources.length > 1 && (
        <div className="filter-row">
          <button className={`filter-btn ${from === null ? "active" : ""}`} onClick={() => setFrom(null)}>
            전부
          </button>
          {sources.map((s) => (
            <button key={s.name} className={`filter-btn ${from === s.name ? "active" : ""}`} onClick={() => setFrom(s.name)}>
              {s.name} {s.n}
            </button>
          ))}
        </div>
      )}

      {err && <div className="error-banner">{err}</div>}
      {data && data.items.length === 0 && !loading && (
        <div className="page-note">
          그 시간 안에는 뉴스도 채널 글도 없습니다. 창을 넓혀 보세요 — <b>조용한 것</b>과
          <b> 못 받은 것</b>은 다르므로, 위의 「뉴스 0 · 채널 0」이 그 둘을 가릅니다.
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
