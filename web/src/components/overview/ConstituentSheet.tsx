import { useEffect, useMemo, useState } from "react";
import { useSheetBack } from "../../useSheetBack";
import { api, fmtNum, normalizeStockCode, signClass, type StockRow } from "../../api";
import { fid, krxOverlayLive, useRealtime } from "../../useRealtime";
import { SortableTh, useSortableTable } from "../../useSortableTable";
import { WatchStar } from "../../useWatchedCodes";
import { SuperMark } from "../../useSuperMarks";
import { UsBridgeBlock } from "../UsBridgeBlock";
import { notifyMyTagsChanged } from "../../myTagsBus";

export interface ConstituentTarget {
  kind: "theme" | "sector" | "custom";
  code: string;
  name: string;
  market?: "kospi" | "kosdaq"; // 업종일 때만
  /**
   * 내 테마일 때 구성종목을 그대로 넘긴다.
   * 이미 손에 있는 걸 다시 조회할 이유가 없다 — 테마 평가에서 받아온 그 값이다.
   */
  stocks?: StockRow[];
  /**
   * 제목에 붙일 이름표. 안 주면 `kind` 로 정한다.
   *
   * `custom` 이 「내 테마」만 뜻하지 않게 됐다 — 리포트의 **미국 테마 MAP** 도
   * 이걸 쓰는데 그건 해외 관심종목 그룹이다. 「내 테마 구성종목」이라고 뜨면 거짓말이다.
   */
  label?: string;
}

/** 테마/업종 구성종목 목록 시트 */
export function ConstituentSheet({
  target,
  onClose,
  onSelectStock,
}: {
  target: ConstituentTarget;
  onClose: () => void;
  onSelectStock: (code: string, name: string) => void;
}) {
  /* 뒤로가기로 닫힌다 — 폰에서 시트를 열고 뒤로 누르면 페이지가 넘어갔다 (2026-08-28) */
  useSheetBack(true, onClose);
  const [items, setItems] = useState<StockRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /*
   * **실시간으로 덮는다** (2026-09-17 — 벤티지: "태그 구성종목 시세랑 종목분석 시세가 안 맞는다").
   *
   * 내 태그는 전종목 스냅샷(장중 10분 캐시)에서, 테마·업종은 키움 구성종목 캐시에서 온 값이라 열 때 이미
   * 몇 분 묵은 시세였다 — 아모센스가 VI 로 +10% 인데 여기는 +2.95% 였다. 시세분석·관심종목과 같은 길로
   * 실시간(0B) 값을 덮는다. 국내 여섯 자리 코드만, 위 40종목까지(임시 구독 정원). 실시간이 안 오는 종목은 그대로.
   */
  const liveKeys = useMemo(
    () =>
      krxOverlayLive()
        ? items
            .map((s) => normalizeStockCode(s.code))
            .filter((c) => /^\d{6}$/.test(c))
            .slice(0, 40)
            .map((c) => `0B:${c}`)
        : [],
    [items],
  );
  const rt = useRealtime(liveKeys, 1500);
  const { liveItems, liveCodes } = useMemo(() => {
    const codes = new Set<string>();
    const rows = items.map((s) => {
      const code = normalizeStockCode(s.code);
      const v = rt.healthy ? rt.values[`0B:${code}`] : null;
      if (!v || Date.now() - v.at > 90_000) return s;
      const p = fid(v, "10");
      if (p === null || p === 0) return s;
      const price = Math.abs(p);
      codes.add(code);
      return {
        ...s,
        price,
        change: fid(v, "11") ?? s.change,
        changeRate: fid(v, "12") ?? s.changeRate,
        /* 시총은 상장주식수 × 현재가 — 가격이 바뀐 만큼만 같이 민다 */
        marketCap: s.marketCap && s.price ? Math.round((s.marketCap * price) / s.price) : s.marketCap,
      };
    });
    return { liveItems: rows, liveCodes: codes };
  }, [items, rt]);
  const sort = useSortableTable(liveItems);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    // 내 테마는 이미 받아온 구성종목을 그대로 쓴다 (조회 0회)
    if (target.stocks) {
      /*
       * ⚠️ 시총순으로 정렬하는데 **해외 그룹은 시총이 전부 0** 이다(안 받아온다).
       * 그러면 정렬이 아무 일도 안 해서 들어온 순서가 그대로 남는다 —
       * 「왜 이 순서지」가 된다. 시총이 없으면 **등락률순**으로 세운다.
       */
      const hasCap = target.stocks.some((s) => (s.marketCap ?? 0) > 0);
      setItems(
        [...target.stocks].sort((a, b) =>
          hasCap ? (b.marketCap ?? 0) - (a.marketCap ?? 0) : b.changeRate - a.changeRate,
        ),
      );
      setLoading(false);
      return;
    }

    /*
     * ⚠️ **네이버 테마는 키움에 물어보면 안 된다** (2026-08-28).
     *
     * 신호등의 「테마 강세(네이버)」가 `kr:449` 같은 **우리 키**를 링크로 넘기는데,
     * 그걸 그대로 `themeStocks`(키움 ka90002)에 넣으면 전혀 다른 테마가 나온다 —
     * 삼성SDI 를 눌렀더니 엉뚱한 종목들이 떴다.
     * 이 키는 우리 파일에 있으므로 서버의 테마 강도에서 꺼내 쓴다(조회 0회).
     */
    if (target.kind === "theme" && /^(kr|us|etf):/.test(target.code)) {
      const market = target.code.startsWith("us")
        ? "us"
        : target.code.startsWith("etf")
          ? "etf"
          : "kr";
      api
        .themeStrength(market)
        .then((r) => {
          if (cancelled) return;
          const t = r.themes.find((x) => x.key === target.code);
          setItems(
            (t?.stocks ?? []).map((s) => ({
              code: s.code,
              name: s.name,
              price: s.price ?? 0,
              change: s.change ?? 0,
              changeRate: s.changeRate ?? 0,
              marketCap: s.marketCap ?? null,
            })),
          );
        })
        .catch((err: Error) => !cancelled && setError(err.message))
        .finally(() => !cancelled && setLoading(false));
      return;
    }

    const req =
      target.kind === "theme"
        ? api.themeStocks(target.code)
        : api.sectorStocks(target.market ?? "kospi", target.code);
    req
      .then((res) => {
        // 시총이 큰 종목일수록 테마·업종을 실제로 끌고 가는 힘이 크므로 기본 정렬을 시총순으로
        if (!cancelled) setItems([...res.items].sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0)));
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target.kind, target.code, target.market, target.stocks]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <h2>
            {target.name}
            <span className="sheet-sub">
              {target.label ??
                (target.kind === "custom" ? "내 태그" : target.kind === "theme" ? "테마" : "업종")}{" "}
              구성종목
            </span>
          </h2>
          {/*
            **＋ 내 태그** (2026-09-15 — 벤티지: "테마 누르면 테마 종목 나오잖아? 네이버 테마 이런 데에서 거기에
            내 태그 추가 버튼 만들어서 내 태그에 바로 추가될 수 있도록 해 줘" · "여기 창에서 오른쪽 위에").
            내 태그를 보고 있을 땐 필요 없고, 미국·ETF 는 국내 종목이 아니라 태그에 못 담는다.
          */}
          {target.kind !== "custom" && !/^(us|etf):/.test(target.code) && items.length > 0 && (
            <AddToMyTag name={target.name} codes={items.map((s) => normalizeStockCode(s.code))} />
          )}
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* 네이버 국내 테마면 미국 짝 — 테마 DB 상세와 같은 칸 (2026-09-15, themeBridge) */}
        {target.kind === "theme" && target.code.startsWith("kr:") && (
          <UsBridgeBlock no={Number(target.code.slice(3))} onSelectStock={onSelectStock} />
        )}

        {loading && <div className="empty">불러오는 중...</div>}
        {error && <div className="error-banner">{error}</div>}

        {!loading && !error && items.length === 0 && (
          <div className="empty">
            구성종목 데이터가 없습니다. (키움 API가 일부 업종코드는 제공하지 않습니다)
          </div>
        )}

        {!loading && !error && items.length > 0 && (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh columnKey="name" label="종목명" accessor={(s: StockRow) => s.name} sort={sort} className="sticky-col" />
                  <SortableTh columnKey="price" label="현재가" accessor={(s: StockRow) => s.price} sort={sort} />
                  <SortableTh columnKey="change" label="전일대비" accessor={(s: StockRow) => s.change} sort={sort} />
                  <SortableTh columnKey="changeRate" label="등락률" accessor={(s: StockRow) => s.changeRate} sort={sort} />
                  <SortableTh columnKey="marketCap" label="시가총액(억)" accessor={(s: StockRow) => s.marketCap ?? 0} sort={sort} />
                </tr>
              </thead>
              <tbody>
                {sort.sorted.map((s, i) => {
                  const code = normalizeStockCode(s.code);
                  return (
                    <tr
                      key={`${code}-${i}`}
                      className="clickable-row"
                      onClick={() => onSelectStock(code, s.name)}
                    >
                      <td className="sticky-col">
                        <WatchStar code={code} />
<SuperMark code={code} />
                        {s.name}
                      </td>
                      {/*
                        넘겨받은 구성종목에는 현재가·전일대비가 없을 수 있다(테마 평가는
                        등락률만 쓴다). 그때 0 을 찍으면 **값이 0원인 것처럼 보인다** —
                        모르는 것은 「-」로 둔다.
                      */}
                      <td>
                        {liveCodes.has(code) && <span className="live-mark" title="실시간 체결값">●</span>}
                        {s.price ? fmtNum(s.price) : "-"}
                      </td>
                      <td className={signClass(s.change)}>{s.price ? fmtNum(s.change) : "-"}</td>
                      <td className={signClass(s.changeRate)}>
                        {s.changeRate > 0 ? "+" : ""}
                        {s.changeRate.toFixed(2)}%
                      </td>
                      <td>{s.marketCap ? fmtNum(s.marketCap) : "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="table-note">
              {items.length}개 종목 · 시가총액 큰 순 · 시가총액 = 상장주식수 × 현재가 (억원) · 종목을 누르면 상세로
              이동합니다
              {liveCodes.size > 0
                ? ` · ● ${liveCodes.size}종목은 실시간 체결값, 나머지는 받아 둔 시세`
                : liveKeys.length > 0
                  ? " · 받아 둔 시세(몇 분 전) — 실시간이 붙으면 ● 로 바뀝니다"
                  : ""}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 이 테마의 구성종목을 **내 태그로 담는다** (2026-09-15).
 *
 * 누르면 곧바로 담긴다 — 벤티지가 「바로 추가」를 원했다. 이름은 테마 이름 그대로.
 *
 * **같은 이름이 이미 있으면 묻는다** (벤티지: "똑같은 이름이 겹치는 경우에 대해서도 처리 좀 해 줘").
 * 조용히 합치면 내가 만든 태그에 남의 분류 종목이 섞여 들어가도 모른다. 그래서 작은 창을 띄워
 * 「기존 태그에 빠진 N종목 더하기 · 새 이름(○○ 2)으로 만들기 · 그만두기」 중에 고르게 한다.
 * 이름 확인은 계산 없는 원본 목록(`/custom-themes/raw`)으로 — 등락 계산이 붙은 목록은 첫 조회가 20초다.
 *
 * 담고 나면 `notifyMyTagsChanged` — 떠 있는 「내 태그」 판·MAP 이 다시 읽는다.
 */
function AddToMyTag({ name, codes }: { name: string; codes: string[] }) {
  const [state, setState] = useState<"idle" | "busy" | "ask" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  const [dup, setDup] = useState<{ id: string; have: string[]; more: string[]; freeName: string } | null>(null);
  const uniq = [...new Set(codes)];

  const finish = (m: string) => {
    setState("done");
    setMsg(m);
    setDup(null);
    notifyMyTagsChanged();
  };
  const fail = (e: unknown) => {
    setState("error");
    setMsg(e instanceof Error ? e.message : String(e));
  };

  const start = async () => {
    setState("busy");
    try {
      const r = await api.customThemesRaw();
      const same = r.themes.find((t) => t.name === name);
      if (!same) {
        await api.customThemeCreate({ name, codes: uniq, memo: "테마/업종 MAP 에서 담음" });
        finish(`내 태그 「${name}」 · ${uniq.length}종목`);
        return;
      }
      const have = same.codes.map((c) => normalizeStockCode(c));
      const hs = new Set(have);
      const names = new Set(r.themes.map((t) => t.name));
      let n = 2;
      while (names.has(`${name} ${n}`)) n += 1;
      setDup({ id: same.id, have, more: uniq.filter((c) => !hs.has(c)), freeName: `${name} ${n}` });
      setState("ask");
    } catch (e) {
      fail(e);
    }
  };

  const merge = async () => {
    if (!dup) return;
    setState("busy");
    try {
      if (dup.more.length > 0) await api.customThemeUpdate(dup.id, { codes: [...dup.have, ...dup.more] });
      finish(dup.more.length > 0 ? `「${name}」에 ${dup.more.length}종목 더함` : `「${name}」에 이미 다 있음`);
    } catch (e) {
      fail(e);
    }
  };

  const makeNew = async () => {
    if (!dup) return;
    setState("busy");
    try {
      await api.customThemeCreate({ name: dup.freeName, codes: uniq, memo: "테마/업종 MAP 에서 담음" });
      finish(`내 태그 「${dup.freeName}」 · ${uniq.length}종목`);
    } catch (e) {
      fail(e);
    }
  };

  return (
    <span className="cs-addtag-wrap">
      <button
        type="button"
        className={`cs-addtag${state === "done" ? " done" : ""}${state === "error" ? " err" : ""}`}
        disabled={state === "busy" || state === "done" || state === "ask"}
        onClick={() => void start()}
        title={msg || "이 테마의 구성종목을 내 태그로 담습니다"}
      >
        {state === "busy" ? "담는 중…" : state === "done" ? "✓ 내 태그" : state === "error" ? "다시 시도" : "＋ 내 태그"}
      </button>
      {state === "ask" && dup && (
        <span className="cs-addtag-pop" role="dialog" aria-label="같은 이름의 태그가 있습니다">
          <span className="cs-addtag-q">
            「{name}」 태그가 이미 있어요 ({dup.have.length}종목)
          </span>
          <button type="button" className="cs-addtag-opt" onClick={() => void merge()} disabled={dup.more.length === 0}>
            {dup.more.length > 0 ? `기존 태그에 ${dup.more.length}종목 더하기` : "이미 다 들어 있어요"}
          </button>
          <button type="button" className="cs-addtag-opt" onClick={() => void makeNew()}>
            새로 만들기 「{dup.freeName}」
          </button>
          <button
            type="button"
            className="cs-addtag-opt cancel"
            onClick={() => {
              setDup(null);
              setState("idle");
            }}
          >
            그만두기
          </button>
        </span>
      )}
      {state === "done" && <span className="cs-addtag-msg">{msg}</span>}
    </span>
  );
}
