import { tileHeat, type ThemeName } from "../useAppearance";
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

/** 한 화면에 이 이상은 그리지 않는다 — 그 아래는 눌러도 손끝보다 작다 */
const MAX_TILES = 48;

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
  const shown = [...withWeight].sort((a, b) => rawOf(b) - rawOf(a)).slice(0, MAX_TILES);
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
    <div className="map-tree">
      {rects.map((r) => {
        /* 넓이(%²)로 글자 크기를 정한다 — 폭만 보면 가로로 긴 타일이 과하게 커진다 */
        const area = r.w * r.h;
        const font = Math.max(9, Math.min(19, 8 + Math.sqrt(area) * 1.5));
        /*
         * 꼬리가 아주 길다 — 실측에서 제일 큰 타일과 제일 작은 타일의 넓이가
         * **11,829배** 났다(반도체 516×547px vs 양자 5×5px). 시가총액 분포가
         * 원래 그렇다. 작은 타일에 글자를 넣으면 잘린 글자 조각만 남아 오히려
         * 지저분하므로, **넓이에 따라 이름까지 지운다**(마우스를 올리면 뜬다).
         */
        /* 상자가 커진 만큼 문턱도 같이 낮춘다 — 안 그러면 늘린 보람이 없다 */
        const showName = area >= 1.2;
        const showPct = area >= 12;
        const showSub = area >= 42;
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
            {showName && <span className="map-tree-name">{r.data.name}</span>}
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
