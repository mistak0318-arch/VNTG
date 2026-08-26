import { Router } from "express";
import { todayDartEvents } from "../dartEvents.js";
import { readEvents, type MarketEvent } from "../eventLog.js";
import type { KiwoomClient } from "../kiwoomClient.js";
import { getMarketSnapshot } from "../marketSnapshot.js";
import { peekRealtime } from "../realtimeHub.js";
import { latestEdition, loadReport } from "../reportStore.js";
import { listGroups, listWatchlist, SUPER_GROUP } from "../watchlist.js";

/**
 * 마켓 브리핑 — **열자마자 3초 안에 「오늘 시장이 어떤가」.**
 *
 * ## 원칙: 여기서 외부 API 를 새로 부르지 않는다
 *
 * 이 라우트가 읽는 것은 전부 **이미 있는 캐시·저장소**다:
 *
 *   타임라인   실시간 저장소의 VI(메모리) + DART(20분 캐시) + 이벤트 로그(파일)
 *   히트맵     관심종목(파일) × 전종목 스냅샷(10분 캐시)
 *   AI 한 줄   마지막 발행 리포트(파일)
 *
 * 지수·수급·테마는 라우트를 새로 만들지 않는다 — 화면이 시황 대시보드와 **같은
 * 섹션 API**(`/api/overview/section/*`)를 그대로 쓴다. 같은 캐시를 두 이름으로
 * 감싸면 언젠가 둘이 갈린다.
 *
 * ⚠️ DART 캐시(20분)가 만료돼 있으면 그 호출이 나간다 — 뉴스·공시 화면과 같은
 * 주기·같은 캐시라 **이 페이지 때문에 늘어나는 호출은 없다.**
 */

/** 타임라인 한 줄 — 화면은 이것만 읽고 그린다 */
export interface TimelineItem {
  /** HH:mm */
  t: string;
  /** vi | dart | telegram | signal | stop | strength */
  kind: string;
  /** 배지에 쓸 이름 — 시그널이면 규칙 이름, 공시면 「공시」 */
  badge: string;
  code?: string;
  name: string;
  summary: string;
  /** 텔레그램 채널 등 출처 — 지라시는 화면이 회색 배지로 */
  source?: string;
  watch: boolean;
  link?: string;
}

function hm(v: string): string {
  // "HHmmss" | ISO | "HH:mm" 무엇이 와도 HH:mm 으로
  if (/^\d{6}$/.test(v)) return `${v.slice(0, 2)}:${v.slice(2, 4)}`;
  if (/^\d{4}-/.test(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) {
      const k = new Date(d.getTime() + 9 * 3600_000);
      return k.toISOString().slice(11, 16);
    }
  }
  return v.slice(0, 5);
}

export function createBriefingRouter(client: KiwoomClient): Router {
  const router = Router();

  /**
   * 오늘의 이벤트 타임라인.
   *
   * VI(실시간 저장소) + 주요 공시(DART 캐시) + 이벤트 로그(키워드·시그널·손절·강도)를
   * 시간 역순으로 합친다. **관심종목 여부는 서버가 판정한다** — 화면마다 각자 대조하면
   * 언젠가 서로 다른 답을 낸다.
   */
  router.get("/timeline", async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 60, 10), 200);
      const watch = new Set(
        (await listWatchlist().catch(() => [])).filter((w) => !w.divider).map((w) => w.code),
      );

      const items: TimelineItem[] = [];

      /* VI — 전 종목이 실시간 저장소에 있다. 실시간이 죽어 있으면 이 소스만 빈다 */
      const { store } = peekRealtime();
      for (const v of store?.getVi(150) ?? []) {
        items.push({
          t: hm(v.firedAt || v.at),
          kind: "vi",
          badge: v.clearedAt ? "VI 해제" : "VI",
          code: v.code,
          name: v.name || v.code,
          summary:
            `${v.apply || v.kind || "발동"}` +
            (v.price > 0 ? ` · 발동가 ${v.price.toLocaleString("ko-KR")}` : ""),
          watch: watch.has(v.code),
        });
      }

      /* DART — 이미 관심종목·테마 가중으로 걸러져 있다. 캐시 20분 */
      try {
        const dart = await todayDartEvents();
        for (const d of dart.events.slice(0, 60)) {
          items.push({
            t: "공시", // list.json 이 시각을 안 준다 — 없는 값을 지어내지 않는다
            kind: "dart",
            badge: d.amended ? "정정공시" : "공시",
            code: d.stockCode || undefined,
            name: d.corpName,
            summary: d.title,
            watch: d.watched,
            link: d.url,
          });
        }
      } catch {
        /* DART 가 죽어도 나머지 소스는 나간다 */
      }

      /* 이벤트 로그 — 키워드·시그널·손절·체결강도. 텔레그램 세션이 없는 기기(개발 PC)면
         telegram 소스만 자연히 빈다. 코드 수정 없이, 쌓이기 시작하면 그대로 나온다 */
      /*
       * ⚠️ 오늘 파일만 읽으면 **자정이 지나는 순간 급증·시그널이 통째로 사라진다**
       * (2026-08-27 새벽 실사용 — "있던 거 어디 갔어"). VI 는 실시간 저장소에 어제
       * 것이 남아 계속 보이는데 로그만 비니 그 칸만 없어진 모양이 됐다.
       * 오늘 것이 비어 있으면 **마지막으로 기록이 있는 날**(3일 안)로 되돌아가고,
       * 어느 날 것인지 eventDay 로 화면에 알린다 — 새 장이 열려 오늘 파일이
       * 생기는 순간 자연히 오늘 것으로 돌아온다.
       */
      const kstDay = (back = 0) =>
        new Date(Date.now() + 9 * 3600_000 - back * 86_400_000).toISOString().slice(0, 10);
      let eventDay = kstDay();
      let logRows = await readEvents(eventDay);
      for (let back = 1; back <= 3 && logRows.length === 0; back += 1) {
        const d = kstDay(back);
        const rows = await readEvents(d);
        if (rows.length > 0) {
          eventDay = d;
          logRows = rows;
        }
      }
      for (const e of logRows) {
        items.push({
          t: hm(e.at),
          kind: e.kind,
          badge:
            e.kind === "telegram"
              ? "채널"
              : e.kind === "stop"
                ? "손절"
                : e.kind === "strength"
                  ? "체결강도"
                  : (e.rule ?? "시그널"),
          code: e.code,
          name: e.name,
          summary: e.summary,
          source: e.source,
          watch: e.watch,
          link: e.link,
        });
      }

      /* 시각 역순 — 시각이 없는 공시는 맨 아래 묶음으로 */
      const timed = items.filter((i) => /^\d{2}:\d{2}$/.test(i.t));
      const untimed = items.filter((i) => !/^\d{2}:\d{2}$/.test(i.t));
      timed.sort((a, b) => b.t.localeCompare(a.t));
      /*
       * ⚠️ 상한은 **VI 따로, 나머지 따로** (2026-08-25).
       * VI 가 하루 수백 건이라 한 상한에 넣으면 공시·시그널이 밀려 없어졌다 —
       * 화면은 VI 를 맨 아래 자기 칸에 그리므로, 서로 자리를 뺏을 이유가 없다.
       */
      const merged = [...timed, ...untimed];
      const vi = merged.filter((i) => i.kind === "vi").slice(0, limit);
      const rest = merged.filter((i) => i.kind !== "vi").slice(0, limit);
      res.json({
        items: merged.filter((i) => vi.includes(i) || rest.includes(i)),
        /* 로그 이벤트가 어느 날 것인가 — 오늘이 아니면 화면이 「(08/26 장)」을 단다 */
        eventDay,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 관심종목 히트맵 — 관심종목 × 전종목 스냅샷. 조회 0회 추가.
   *
   * 타일 크기는 **시가총액**으로 잰다 — 지시서는 거래대금이었지만 스냅샷에 거래대금이
   * 없다(그건 순위 TR 몫이다). 없는 값을 채우려고 조회를 만드는 건 이 페이지의
   * 원칙 위반이라, 있는 값 중 가장 뜻이 가까운 것으로 대신한다.
   */
  router.get("/heat", async (_req, res, next) => {
    try {
      const [items, groups, snap] = await Promise.all([
        listWatchlist(),
        listGroups().catch(() => [] as string[]),
        getMarketSnapshot(client).catch(() => null),
      ]);
      /*
       * 정렬 (2026-08-26 사용자 지정) — 슈퍼신호등 그룹이 맨 앞, 그 뒤는 그룹
       * 정렬순. 같은 그룹 안에서는 등락률 내림차순. 여러 그룹에 든 종목은
       * 슈퍼신호등이 있으면 그걸, 아니면 그룹 순서가 앞선 것을 대표로 삼는다.
       */
      const groupRank = new Map<string, number>();
      groupRank.set(SUPER_GROUP, -1); // 슈퍼신호등이 늘 맨 앞
      groups.forEach((g, i) => {
        if (!groupRank.has(g)) groupRank.set(g, i);
      });
      const primaryGroup = (gs: string[]): string => {
        if (gs.includes(SUPER_GROUP)) return SUPER_GROUP;
        let best = gs[0] ?? "";
        for (const g of gs) {
          if ((groupRank.get(g) ?? 999) < (groupRank.get(best) ?? 999)) best = g;
        }
        return best;
      };
      /*
       * ⚠️ 등락률은 **실시간이 우선**이다 (2026-08-25).
       *
       * 스냅샷은 10분 캐시라, 타일의 −7.29% 를 눌러 들어가면 상세는 −5.8% 인 일이
       * 실제로 났다 — 같은 화면에서 두 값이 다르면 어느 쪽도 못 믿게 된다.
       * 관심종목은 전부 실시간 keep 목록에 있으므로(0B), 10분 안에 받은 체결이
       * 있으면 그 등락률(FID 12)을 쓰고, 없을 때만 스냅샷으로 돌아간다.
       */
      const { store } = peekRealtime();
      const liveRate = (code: string): number | null => {
        const l = store?.getLatest("0B", code);
        if (!l || Date.now() - l.at > 10 * 60_000) return null;
        const n = Number(String(l.values["12"] ?? "").replace(/,/g, ""));
        return Number.isFinite(n) ? n : null;
      };
      const tiles = items
        .filter((w) => !w.divider)
        .map((w) => {
          const s = snap?.byCode.get(w.code);
          return {
            code: w.code,
            name: w.name,
            rate: liveRate(w.code) ?? s?.changeRate ?? null,
            cap: s?.marketCap ?? null,
            status: w.status ?? "watching",
            group: primaryGroup(w.groups),
          };
        })
        .sort((a, b) => {
          const ga = groupRank.get(a.group) ?? 999;
          const gb = groupRank.get(b.group) ?? 999;
          if (ga !== gb) return ga - gb;
          return (b.rate ?? -999) - (a.rate ?? -999);
        });
      res.json({ traded: snap?.traded ?? false, tiles });
    } catch (err) {
      next(err);
    }
  });

  /**
   * AI 한 줄 — **새 호출 없이** 마지막 발행 리포트의 앞 문장들을 재사용한다.
   * 브리핑 하나 보자고 Claude 를 또 부르면 비용이 들고, 수치가 새로 들어가면
   * 환각 검증도 다시 해야 한다. 발행분은 이미 채점 루프까지 붙어 있는 글이다.
   */
  router.get("/brief", async (_req, res, next) => {
    try {
      const latest = latestEdition();
      const report = latest ? await loadReport(latest.date, latest.edition) : null;
      const text = report?.summary.text ?? "";
      if (!text.trim()) {
        res.json({ brief: null });
        return;
      }
      /* 머리기호·제목 줄을 걷어 내고 본문 문장 셋만 */
      const sentences = text
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith("#"))
        .join(" ")
        .split(/(?<=[.다요])\s+/)
        .filter((s) => s.trim().length > 10)
        .slice(0, 3);
      res.json({
        brief: sentences.length > 0
          ? { date: report!.date, label: report!.label, text: sentences.join(" ") }
          : null,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
