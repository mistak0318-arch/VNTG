import { useEffect, useState } from "react";
import { useSheetBack } from "../../useSheetBack";
import { api, fmtNum, normalizeStockCode, signClass, type StockRow } from "../../api";
import { SortableTh, useSortableTable } from "../../useSortableTable";
import { WatchStar } from "../../useWatchedCodes";
import { SuperMark } from "../../useSuperMarks";
import { UsBridgeBlock } from "../UsBridgeBlock";

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
  const sort = useSortableTable(items);

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
                      <td>{s.price ? fmtNum(s.price) : "-"}</td>
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
 * 누르면 곧바로 담긴다 — 벤티지가 「바로 추가」를 원했다. 이름은 테마 이름 그대로. 같은 이름의 태그가
 * 이미 있으면 새로 만들지 않고 **빠진 종목만 더한다**(서버가 같은 이름을 거절하므로 그 경우를 받아 합친다).
 * 태그는 종목 상세 메모 위 #태그와 같은 것이라, 담는 즉시 「내 태그」 MAP 에 뜬다.
 */
function AddToMyTag({ name, codes }: { name: string; codes: string[] }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");

  const add = async () => {
    setState("busy");
    const uniq = [...new Set(codes)];
    try {
      await api.customThemeCreate({ name, codes: uniq, memo: "테마/업종 MAP 에서 담음" });
      setState("done");
      setMsg(`내 태그 「${name}」 · ${uniq.length}종목`);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (!/같은 이름/.test(m)) {
        setState("error");
        setMsg(m);
        return;
      }
      /* 이미 있는 태그 — 빠진 종목만 더한다 */
      try {
        const r = await api.customThemes();
        const t = r.themes.find((x) => x.name === name);
        if (!t) throw new Error("같은 이름의 태그를 못 찾았습니다");
        const have = new Set(t.stocks.map((s) => normalizeStockCode(s.code)));
        const more = uniq.filter((c) => !have.has(c));
        if (more.length > 0) await api.customThemeUpdate(t.id, { codes: [...have, ...more] });
        setState("done");
        setMsg(more.length > 0 ? `「${name}」에 ${more.length}종목 더함` : `「${name}」에 이미 다 있음`);
      } catch (e2) {
        setState("error");
        setMsg(e2 instanceof Error ? e2.message : String(e2));
      }
    }
  };

  return (
    <button
      type="button"
      className={`cs-addtag${state === "done" ? " done" : ""}${state === "error" ? " err" : ""}`}
      disabled={state === "busy" || state === "done"}
      onClick={() => void add()}
      title={msg || "이 테마의 구성종목을 내 태그로 담습니다 — 같은 이름이 있으면 빠진 종목만 더합니다"}
    >
      {state === "busy" ? "담는 중…" : state === "done" ? "✓ 내 태그" : state === "error" ? "다시 시도" : "＋ 내 태그"}
    </button>
  );
}
