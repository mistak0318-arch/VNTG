import { tileHeat, type ThemeName } from "../useAppearance";
import { useEffect, useState } from "react";
import { treemap } from "../treemap";

/**
 * 크기가 뜻을 가지는 MAP (2026-08-30 요청).
 *
 * ## 왜 바꿨나
 *
 * 지금까지 타일은 전부 같은 크기였다. 그러면 **「+7% 짜리 손톱만한 테마」와
 * 「+7% 짜리 시장의 기둥」이 똑같이 그려진다** — 색만 보고는 어느 쪽이 시장을
 * 실제로 움직이는지 알 수 없다. 네이버 HOT 테마가 크기를 주는 이유가 그것이다.
 *
 *   크기 = 규모(시가총액 또는 거래대금) · 색 = 오늘 등락
 *
 * ## 크기 기준을 고를 수 있게 둔다
 *
 * 시총은 「이 판이 얼마나 큰가」이고 거래대금은 「오늘 돈이 얼마나 도는가」다.
 * 둘은 자주 어긋난다 — 시총 큰 테마가 조용하고 작은 테마에 돈이 몰리는 날이
 * 오히려 중요한 날이다. 그래서 **고르게 두고**, 균등 배치도 남긴다(예전 화면을
 * 그리워할 수 있고, 규모 데이터가 없는 모드도 있다).
 *
 * ## 작은 것은 글자를 줄이거나 지운다
 *
 * 트리맵은 꼬리가 길다 — 아래쪽 타일은 손톱만 해진다. 거기에 같은 크기 글자를
 * 넣으면 넘쳐서 옆 타일을 침범한다. **타일 넓이에 따라 글자 크기를 정하고, 너무
 * 작으면 이름만, 더 작으면 아무것도 안 쓴다**(마우스를 올리면 이름이 뜬다).
 */

export type SizeMode = "cap" | "value" | "flat";

export interface MapTile {
  key: string;
  name: string;
  changeRate: number;
  /** 아래 작은 글씨 (▲3/▼5 같은 것) */
  sub?: string;
  /** 시가총액(억) — 없으면 이 모드에서는 균등으로 떨어진다 */
  marketCap?: number | null;
  /** 거래대금(억) */
  tradeValue?: number | null;
  title?: string;
  onClick: () => void;
}

/**
 * 크기 차이를 얼마나 눌러 그릴지.
 *
 * ⚠️ 시가총액 분포는 **극단적으로 치우쳐 있다.** 실측에서 제일 큰 테마와 작은 테마가
 * **381배**였고, 그대로 그리면 반도체 하나가 화면 절반을 먹고 나머지는 몇 픽셀이
 * 되어 **누를 수조차 없었다.**
 *
 * 그래서 넓이를 값의 **거듭제곱(0.45)** 으로 잡는다. 순서는 그대로고 비율만 완만해진다
 * — 381배가 **14배**쯤으로 준다. 「넓이가 값에 정비례한다」는 성질은 잃지만,
 * **못 누르는 타일은 애초에 정보가 아니다.**
 *
 * 정확한 값이 필요하면 타일에 마우스를 올리면 나온다. 그리고 아래 「실제 비율」을
 * 켜면 누르지 않은 원래 그림을 볼 수 있다.
 */
const COMPRESS_POWER = 0.45;

/**
 * 몇 개까지 그릴지는 **상자 크기가 정한다** (2026-08-31).
 *
 * ⚠️ 예전엔 48 로 못 박혀 있었다. 1400px 화면에 맞춰 고른 수인데, 고해상도
 * 모니터에서는 그 48개가 상자를 나눠 가지면서 **타일 하나가 200px 짜리 덩어리**가
 * 됐다 — 화면은 넓어졌는데 보이는 테마 수는 그대로였다.
 *
 * 그래서 「몇 개」가 아니라 **「제일 작은 타일이 아직 누를 만한가」**로 정한다.
 * 넓은 화면에서는 자연히 더 많이, 폰에서는 더 적게 그려진다.
 */
const MIN_TILE_PX = 26; // 손끝으로 누를 수 있는 최소 한 변
const HARD_CAP = 160; // 이 이상은 사람이 훑지 못한다

/**
 * 상자 넓이에 맞는 타일 수.
 *
 * 정렬된 무게 배열에서 앞 N개만 그리면 제일 작은 타일의 넓이는
 * `상자넓이 × wN / Σ(w1..wN)` 이다. 그 값이 문턱 아래로 떨어지기 직전까지 늘린다.
 */
function fitCount(weights: number[], boxArea: number): number {
  if (boxArea <= 0) return 24; // 아직 못 쟀다 — 첫 그림은 적당히
  const floor = MIN_TILE_PX * MIN_TILE_PX;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < Math.min(weights.length, HARD_CAP); i += 1) {
    const next = sum + weights[i];
    if (i > 0 && (boxArea * weights[i]) / next < floor) break;
    sum = next;
    n = i + 1;
  }
  return Math.max(8, n);
}

export function TreemapGrid({
  tiles,
  sizeBy,
  theme,
  compress = true,
}: {
  tiles: MapTile[];
  sizeBy: SizeMode;
  theme: ThemeName;
  /** 크기 차이를 눌러 그릴지. 끄면 넓이가 값에 정비례한다(작은 것은 안 보인다) */
  compress?: boolean;
}) {
  /*
   * 상자를 **실제로 재서** 몇 개를 그릴지 정한다 (2026-08-31).
   * 창 크기·사이드바 접기·본문 폭 설정이 바뀌면 그때마다 다시 잰다.
   */
  const [boxEl, setBoxEl] = useState<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  /*
   * ⚠️ **콜백 ref 로 직접 잰다.**
   *
   * 두 가지를 겪고 여기로 왔다:
   *   ① `useRef` + `[]` 효과 — 자료가 오기 전 첫 그림에는 이 상자가 없어서(균등
   *      배치로 빠진다) 관찰자가 못 붙고, 나중에 상자가 생겨도 효과가 다시 안 돈다.
   *   ② `ResizeObserver` — 붙기는 하는데 값이 상태로 안 들어와 **0×0 에 굳었다**
   *      (실측: DOM 은 1360×819 인데 상태는 0×0, 창을 줄였다 늘려도 그대로).
   *
   * 그래서 상자가 붙는 그 순간 `getBoundingClientRect` 로 재고, 그 뒤로는 창 크기
   * 변화만 듣는다. 잴 일이 그것뿐이다 — 이 상자는 화면 폭을 그대로 따라간다.
   */
  const measure = (el: HTMLDivElement | null) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    /*
     * ⚠️ **0 은 재지 않는다.** 탭 판이 숨겨져 있는 동안(display:none) 재면 0×0 이
     * 나오는데, 그걸 좋은 값 위에 덮으면 다시 보일 때 타일이 전부 0 크기로 그려진다
     * (실측으로 그 꼴을 봤다). 못 쟀으면 **직전 값을 그대로 둔다.**
     */
    if (r.width < 1 || r.height < 1) return;
    /* 몇 픽셀 흔들림으로 타일 수가 요동치면 화면이 깜빡인다 — 20px 단위로 반올림 */
    const w = Math.round(r.width / 20) * 20;
    const h = Math.round(r.height / 20) * 20;
    setBox((p) => (p.w === w && p.h === h ? p : { w, h }));
  };

  useEffect(() => {
    if (!boxEl) return;
    /* 첫 값은 **직접 잰다** — 관찰자만 믿으면 0×0 으로 굳는 경우를 실제로 겪었다 */
    measure(boxEl);
    /*
     * 그 뒤의 변화는 관찰자가 맡는다. 창 크기 말고도 상자가 바뀌는 길이 여럿이다 —
     * 사이드바 접기, 본문 폭 설정, 탭 전환, 글자 크기. 창 이벤트만 들으면 그것들을
     * 다 놓친다. 관찰자가 못 깨워도 첫 측정은 이미 끝나 있으니 최악이 옛 그림이다.
     */
    const ro = new ResizeObserver(() => measure(boxEl));
    ro.observe(boxEl);
    const onResize = () => measure(boxEl);
    window.addEventListener("resize", onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
    };
    /*
     * 타일 묶음·크기 기준이 바뀔 때도 다시 잰다.
     *
     * 서브탭을 옮기면 상자는 그대로여도 **그 안에 담길 내용이 달라지고**, 그때
     * 화면이 이미 다른 폭으로 바뀌어 있을 수 있다(탭 판이 안 사라지고 숨기만 하는
     * 구조라 ref 가 다시 안 붙는다). 관찰자에 기대지 않는 세 번째 길이다.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxEl, tiles.length, sizeBy, compress]);

  const rawOf = (t: MapTile): number =>
    sizeBy === "cap" ? (t.marketCap ?? 0) : sizeBy === "value" ? (t.tradeValue ?? 0) : 0;
  const weightOf = (t: MapTile): number => {
    const v = rawOf(t);
    return v > 0 && compress ? Math.pow(v, COMPRESS_POWER) : v;
  };

  /*
   * 규모 데이터가 절반도 없으면 트리맵이 거짓말이 된다 — 값이 없는 것들이 전부
   * 사라져 「그 테마는 없는 것」처럼 보인다. 그럴 땐 조용히 균등 배치로 돌아간다.
   */
  const withWeight = tiles.filter((t) => weightOf(t) > 0);
  const usable = sizeBy !== "flat" && withWeight.length >= tiles.length * 0.5 && withWeight.length > 0;
  /* 큰 것부터 잘라 낸다 — 뒤쪽은 어차피 못 누른다 */
  const sorted = [...withWeight].sort((a, b) => rawOf(b) - rawOf(a));
  const shown = sorted.slice(0, fitCount(sorted.map(weightOf), box.w * box.h));
  const hidden = withWeight.length - shown.length;

  if (!usable) {
    return (
      <div className="map-grid">
        {tiles.map((t) => (
          <button
            key={t.key}
            className="map-tile"
            style={tileHeat(t.changeRate, theme)}
            onClick={t.onClick}
            title={t.title ?? t.name}
          >
            <span className="map-tile-name">{t.name}</span>
            <span className="map-tile-pct num">{fmtPct(t.changeRate)}</span>
            {t.sub && <span className="map-tile-sub">{t.sub}</span>}
          </button>
        ))}
      </div>
    );
  }

  const rects = treemap(
    shown.map((t) => ({ weight: weightOf(t), data: t })),
    1.35,
  );

  return (
    <>
    <div className="map-tree" ref={setBoxEl}>
      {rects.map((r) => {
        /*
         * 글자 크기와 표시 여부를 **실제 픽셀로** 정한다 (2026-08-31 —
         * "모바일에서 박스안에 글자가 너무커서 하나도 안보여").
         *
         * ⚠️ 전엔 `r.w * r.h`(퍼센트²)로 쟀다. 퍼센트는 **해상도와 무관한 값**이라,
         * 데스크톱의 200px 타일과 폰의 60px 타일이 같은 20%×15% 면 똑같이 19px
         * 글자를 받았다. 상자가 4배 작아졌는데 글자만 그대로였으니 폰에서는
         * 타일이 글자에 통째로 잡아먹혔다.
         *
         * 상자를 이미 재고 있으므로(`box`) 퍼센트를 픽셀로 되돌리면 된다.
         * 아직 못 쟀으면(첫 렌더) 넉넉히 잡아 이름은 보여 준다 — 빈 상자보다는 낫다.
         */
        const pw = box.w > 0 ? (r.w / 100) * box.w : 999;
        const ph = box.h > 0 ? (r.h / 100) * box.h : 999;
        /*
         * 짧은 변을 기준으로 — 가로로 긴 타일은 높이가 글자를 먼저 막는다.
         * 200px 타일에 19px, 60px 에 10px 쯤 되게 골랐다.
         */
        const font = Math.max(8, Math.min(19, 5.5 + Math.min(pw, ph) * 0.068));
        /*
         * 꼬리가 아주 길다 — 실측에서 제일 큰 타일과 제일 작은 타일의 넓이가
         * **11,829배** 났다(반도체 516×547px vs 양자 5×5px). 시가총액 분포가
         * 원래 그렇다. 작은 타일에 글자를 넣으면 잘린 글자 조각만 남아 오히려
         * 지저분하므로, **들어갈 자리가 있을 때만** 적는다(마우스를 올리면 뜬다).
         *
         * 문턱을 넓이가 아니라 **가로·세로 각각**으로 본다. 넓이만 보면 5px × 500px
         * 짜리 띠가 문턱을 넘어 버리는데, 거기엔 아무 글자도 안 들어간다.
         */
        const showName = pw >= 34 && ph >= font + 4;
        /*
         * 긴 이름은 **두 줄로 접는다** — 세로로 여유가 있을 때만.
         * 「반도체 소부장 (후공정)」이 51px 타일에서 "반도체 소…" 로 잘렸는데,
         * 그 타일은 세로가 100px 넘게 남아 있었다. 가로가 모자라면 세로를 쓴다.
         *
         * 한글 한 글자는 대략 글자 크기만큼 넓다(0.95em 어림). 그것으로 한 줄에
         * 들어가는지 재고, 안 들어가고 자리가 있으면 두 줄을 준다.
         */
        const nameW = r.data.name.length * font * 0.95;
        const wrapName = showName && nameW > pw - 6 && ph >= font * 2.4 + 6;
        const lines = wrapName ? 2 : 1;
        /* 아래 줄들의 문턱은 이름이 몇 줄을 먹었는지에 따라 밀린다 */
        const showPct = pw >= 38 && ph >= font * (lines + 1) + 6;
        const showSub = pw >= 52 && ph >= font * (lines + 2) + 8;
        return (
          <button
            key={r.data.key}
            className="map-tree-tile"
            style={{
              left: `${r.x}%`,
              top: `${r.y}%`,
              width: `${r.w}%`,
              height: `${r.h}%`,
              fontSize: `${font}px`,
              ...tileHeat(r.data.changeRate, theme),
            }}
            onClick={r.data.onClick}
            title={`${r.data.title ?? r.data.name} · ${fmtPct(r.data.changeRate)} · ${
              sizeBy === "cap" ? "시총" : "거래대금"
            } ${money(weightOf(r.data))}`}
          >
            {showName && (
              <span className={`map-tree-name${wrapName ? " wrap" : ""}`}>{r.data.name}</span>
            )}
            {showPct && <span className="map-tree-pct num">{fmtPct(r.data.changeRate)}</span>}
            {showSub && r.data.sub && <span className="map-tree-sub">{r.data.sub}</span>}
          </button>
        );
      })}
    </div>
    {hidden > 0 && (
      <p className="map-tree-note">
        규모 상위 <b>{shown.length}개</b>만 그렸습니다 — 나머지 {hidden}개는 화면에서 손톱보다
        작아집니다. 표(테마 DB)에서는 전부 볼 수 있습니다.
      </p>
    )}
    </>
  );
}

function fmtPct(v: number): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

/** 억 단위 값을 사람이 읽는 단위로 */
export function money(eok: number): string {
  if (eok >= 10000) return `${(eok / 10000).toFixed(1)}조`;
  return `${Math.round(eok).toLocaleString("ko-KR")}억`;
}

/** 크기 기준 고르는 단추 — MAP 과 다른 화면이 같은 모양을 쓰게 */
export function SizeByPicker({
  value,
  onChange,
  hasCap,
  hasValue,
  compress,
  onCompress,
}: {
  value: SizeMode;
  onChange: (v: SizeMode) => void;
  hasCap: boolean;
  hasValue: boolean;
  compress: boolean;
  onCompress: (v: boolean) => void;
}) {
  const opts: { key: SizeMode; label: string; ok: boolean; hint: string }[] = [
    { key: "cap", label: "시총", ok: hasCap, hint: "이 판이 얼마나 큰가" },
    { key: "value", label: "거래대금", ok: hasValue, hint: "오늘 돈이 얼마나 도는가" },
    { key: "flat", label: "균등", ok: true, hint: "크기를 안 본다 — 예전 배치" },
  ];
  return (
    <div className="map-sizeby">
      <span>크기</span>
      {opts.map((o) => (
        <button
          key={o.key}
          className={value === o.key ? "on" : ""}
          disabled={!o.ok}
          title={o.ok ? o.hint : "이 모드에는 그 값이 없습니다"}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
      {/* 눌러 그린 것을 원래 비율로 되돌려 보는 단추 — 정직하려면 원본을 볼 길이 있어야 한다 */}
      {value !== "flat" && (
        <button
          className={`map-sizeby-real${compress ? "" : " on"}`}
          onClick={() => onCompress(!compress)}
          title={
            compress
              ? "지금은 크기 차이를 눌러 그리고 있습니다 — 누르면 실제 비율로 봅니다"
              : "넓이가 값에 정비례합니다 — 작은 것은 거의 안 보입니다"
          }
        >
          실제 비율
        </button>
      )}
    </div>
  );
}
