import { useCallback, useEffect, useState } from "react";
import { removePref, setPref } from "../../prefs";
import {
  api,
  fmtNum,
  type RateRow,
  type UsBoardSignal,
  type UsMajorResult,
  type UsQuoteRow,
  type UsWatchGroup,
  type UsSearchResult,
} from "../../api";
import { useSection } from "../../useSection";
import { YahooChartSheet, type ChartTarget } from "./YahooChartSheet";
import { UsSpark } from "./UsSpark";
import { UsWatchTable, sideNameOf } from "../UsWatchTable";
import { tileHeat, useAppearance } from "../../useAppearance";
import { useWatchGroupTiles } from "../../useWatchGroupTiles";
import { ConstituentSheet, type ConstituentTarget } from "./ConstituentSheet";

/**
 * 미국 전광판.
 *
 * 미국장이 열려 있는 동안 보는 자리다. 국내 시황 카드들 사이에 흩어져 있던 미국 값을
 * **한 화면에 세로로 쌓아** 위에서 아래로 훑게 한다 —
 *
 *   지수 넉 장 → 국채금리 → 코스피 야간선물 → 내 관심종목
 *
 * ## 새로 받는 게 없다
 *
 * 지수·금리·야간선물은 시황이 이미 받는 `usMajor`·`rates` 섹션 그대로다.
 * 관심종목은 「관심종목(해외)」가 쓰는 그 저장소를 그대로 쓴다 — 여기서 넣고 빼면
 * 그 화면에서도 같이 바뀐다. **같은 목록을 두 곳에서 따로 관리하게 만들지 않는다.**
 */

/** 위에 큰 상자로 세울 지수 — 국내 지수 카드와 같은 모양 */
/*
 * VIX 를 지수와 같은 줄에 둔다.
 *
 * 지수 넷만 보면 「올랐다/내렸다」는 알아도 **그게 편안한 상승인지 불안한 상승인지**를
 * 모른다. VIX 는 그 한 칸을 채운다. 값이 오르는 게 나쁜 쪽이라 색은 거꾸로 읽어야 하는데,
 * 그건 서버가 붙여 주는 판정 줄(why)이 말해 준다.
 */
const BOX_KEYS = ["gspc", "ndx", "rut", "sox", "vix"] as const;
/** 원자재 — 국채금리 아래 따로. 지수와 단위가 달라 같은 줄에 섞으면 못 읽는다 */
const COMMODITY_KEYS = ["wti", "brent", "gold"] as const;

function pct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "-";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function cls(v: number | null): string {
  if (v === null || !Number.isFinite(v) || v === 0) return "";
  return v > 0 ? "positive" : "negative";
}

/**
 * 지수·원자재 상자 — **국내 코스피/코스닥 카드와 같은 모양.**
 *
 * ## 왜 바꿨나
 *
 * 예전에는 한 줄에 이름·값·등락률을 몰아넣었다. 자리는 아꼈지만 **옆으로 길쭉한
 * 띠**가 되어 한눈에 안 들어왔고, 무엇보다 바로 위 국내 지수 카드와 모양이 달라서
 * 같은 화면 안에서 눈이 두 번 적응해야 했다.
 *
 * 국내 카드는 이미 답을 갖고 있다 — **두 칸씩, 값은 크게, 그 아래 하루치 선.**
 * 그래서 CSS 를 새로 만들지 않고 그 클래스(`ov-idx-*`)를 그대로 쓴다.
 * 나중에 국내 카드 모양을 고치면 여기도 같이 따라간다.
 *
 * 신호 테두리와 판정 한 줄은 이 화면에만 있는 것이라 `usb-` 클래스로 덧붙인다.
 */
function IndexBoxes({
  boxes,
  onPick,
}: {
  boxes: { key: string; label: string; symbol: string; digits: number; price: number | null; changeRate: number | null; signal?: { level: string; why: string } | null }[];
  onPick: (t: ChartTarget) => void;
}) {
  return (
    <div className="ov-idx-grid usb-idx-grid">
      {boxes.map((b) => (
        <button
          type="button"
          className={`ov-idx clickable usb-idx${b.signal ? ` sig-${b.signal.level}` : ""}`}
          key={b.key}
          /* 카드가 든 등락률을 그대로 넘긴다 — 시트가 다시 세면 기준이 갈린다 */
          onClick={() =>
            onPick({ symbol: b.symbol, label: b.label, digits: b.digits, hintRate: b.changeRate })
          }
          title="눌러서 차트 보기"
        >
          <div className="ov-idx-name">{b.label}</div>
          <div className={`ov-idx-val num ${cls(b.changeRate)}`}>
            {b.price === null ? "-" : fmtNum(Number(b.price.toFixed(b.digits)))}
          </div>
          <div className={`ov-idx-chg num ${cls(b.changeRate)}`}>{pct(b.changeRate)}</div>
          <UsSpark symbol={b.symbol} />
          {/* 왜 눈에 띄는지 한 줄. 색만 있으면 이유를 모른다 */}
          {b.signal && <div className="usb-box-why">{b.signal.why}</div>}
        </button>
      ))}
    </div>
  );
}

export function UsBoardPanel() {
  const usMajor = useSection<UsMajorResult>("usMajor", 15_000);
  const rates = useSection<RateRow[]>("rates", 30_000);

  const rows = usMajor.data?.rows ?? [];
  const boxes = BOX_KEYS.map((k) => rows.find((r) => r.key === k)).filter(
    (r): r is NonNullable<typeof r> => Boolean(r),
  );
  const night = usMajor.data?.nightFutures ?? null;
  const commodities = COMMODITY_KEYS.map((k) => rows.find((r) => r.key === k)).filter(
    (r): r is NonNullable<typeof r> => Boolean(r),
  );
  /* 눌러서 차트 — 숫자 한 줄만으로는 「어디쯤인가」를 모른다 */
  const [chart, setChart] = useState<ChartTarget | null>(null);
  const usRates = (rates.data ?? []).filter((r) => r.group === "해외");

  return (
    <div className="usb">
      {/*
        신호등이 맨 위다. 열 줄을 훑어서 「오늘 미국이 괜찮은가」를 세는 건 사람이 할 일이 아니다.
        판정은 서버가 한다 — 화면에서 굴리면 리포트가 같은 판정을 다시 짜야 한다.
      */}
      {usMajor.data?.boardSignal && <BoardLight sig={usMajor.data.boardSignal} />}

      {/*
        지수와 원자재를 **한 카드**로 (2026-08-26 — 「미국 지수 및 원자재로 윗줄에 붙이자」).
        칸이 컴팩트해지면서 여덟 개가 한두 줄에 다 들어온다 — 카드를 나눌 이유가 없어졌다.
      */}
      <section className="ov-card">
        <div className="ov-card-h">
          <span className="ov-card-t">미국 지수 · 원자재</span>
          <span className="ov-card-sub">
            {usMajor.data?.fetchedAt
              ? new Date(usMajor.data.fetchedAt).toLocaleTimeString("ko-KR", { hour12: false })
              : ""}
          </span>
        </div>
        <div className="ov-card-b">
          {boxes.length === 0 && commodities.length === 0 ? (
            <div className="empty">불러오는 중…</div>
          ) : (
            <IndexBoxes boxes={[...boxes, ...commodities]} onPick={setChart} />
          )}
          {usMajor.data?.curveNote && (
            <div className="usb-curve">{usMajor.data.curveNote}</div>
          )}
          <div className="table-note">
            유가는 <b>정유·화학·항공</b>에 바로 닿고, 금은 금리·달러의 반대편이라 같이 보면
            시장이 <b>위험을 사는지 피하는지</b>가 읽힙니다. WTI·브렌트는 선물(근월물)입니다.
          </div>
        </div>
      </section>

      {/* ---------------- 국채금리 ---------------- */}
      <section className="ov-card">
        <div className="ov-card-h">
          <span className="ov-card-t">미국 국채금리</span>
          {/* 갱신 시각을 적어 둔다 — 안 적으면 「이거 살아 있나」를 매번 의심하게 된다 */}
          <span className="ov-card-sub">
            {rates.updatedAt
              ? new Date(rates.updatedAt).toLocaleTimeString("ko-KR", { hour12: false })
              : ""}
          </span>
        </div>
        <div className="ov-card-b">
          {usRates.length === 0 ? (
            <div className="empty">불러오는 중…</div>
          ) : (
            <div className="usb-rates">
              {usRates.map((r) => (
                <div className="usb-rate" key={r.code}>
                  <span className="usb-rate-nm">{r.name}</span>
                  <b className="usb-rate-v">{r.rate === null ? "-" : `${r.rate.toFixed(3)}%`}</b>
                  {/* 금리는 등락률이 아니라 %p 로 읽어야 한다 */}
                  <span className={`usb-rate-d ${cls(r.change)}`}>
                    {r.change === null
                      ? ""
                      : `${r.change > 0 ? "+" : ""}${r.change.toFixed(3)}%p`}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="table-note">
            금리는 <b>%p(변화폭)</b> 로 읽습니다 — 4.71%가 4.72%로 가는 건 등락률로는 0.2%지만
            시장이 반응하는 건 0.01%p 라는 폭 자체입니다.
          </div>
        </div>
      </section>

      {/* 원자재 카드는 위 「미국 지수 · 원자재」로 합쳤다 (2026-08-26) */}

      {/* ---------------- 야간선물 ---------------- */}
      <section className="ov-card">
        <div className="ov-card-h">
          <span className="ov-card-t">코스피 야간선물</span>
          <span className="ov-card-sub">
            {usMajor.data?.fetchedAt
              ? new Date(usMajor.data.fetchedAt).toLocaleTimeString("ko-KR", { hour12: false })
              : ""}
          </span>
        </div>
        <div className="ov-card-b">
          {!night ? (
            <div className="empty">야간선물 값이 아직 없습니다.</div>
          ) : (
            <button
              type="button"
              className="usb-night clickable"
              onClick={() =>
                setChart({
                  kind: "futures",
                  symbol: night.symbol,
                  label: "코스피 야간선물",
                  digits: night.digits,
                  /* 카드가 든 값을 그대로 넘긴다 — 시트가 다시 세면 기준이 갈린다 */
                  hintRate: night.changeRate,
                })
              }
              title="눌러서 차트 보기"
            >
              <div className={`usb-night-px ${cls(night.changeRate)}`}>
                {night.price === null ? "-" : fmtNum(Number(night.price.toFixed(night.digits)))}
              </div>
              <div className={`usb-night-chg ${cls(night.changeRate)}`}>
                {night.change === null
                  ? ""
                  : `${night.change > 0 ? "▲" : "▼"}${Math.abs(night.change).toFixed(night.digits)}`}{" "}
                {pct(night.changeRate)}
              </div>
            </button>
          )}
          <div className="table-note">
            미국장이 열려 있는 동안 움직이는 값이라 <b>내일 개장가의 예고편</b>입니다.
            눌러서 흐름을 볼 수 있습니다 — 월물은 3개월마다 바뀌므로 그 이전 구간은 없습니다.
          </div>
        </div>
      </section>

      {/* ---------------- 관심종목 MAP ---------------- */}
      <UsWatchMap onOpen={(symbol, label) => setChart({ kind: "usStock", symbol, label })} />

      {/* ---------------- 섹터 MAP ---------------- */}
      <UsSectorMap onOpen={(symbol, label) => setChart({ kind: "usStock", symbol, label })} />

      {/* ---------------- 관심종목 ---------------- */}
      <UsBoardWatch onOpen={(symbol, label) => setChart({ kind: "usStock", symbol, label })} />

      {chart && <YahooChartSheet target={chart} onClose={() => setChart(null)} />}
    </div>
  );
}

/**
 * 관심종목 MAP — **한눈에 어디가 도는지.**
 *
 * ## 왜 목록 위에 따로 두나
 *
 * 아래 목록은 종목마다 한 줄이라 스무 개가 넘으면 훑는 데 시간이 걸린다.
 * 밤에 미국장을 볼 때 알고 싶은 건 「어느 그룹이 도는가」와 「어디가 튀는가」인데,
 * 그건 숫자를 읽는 게 아니라 **색 덩어리를 보는 일**이다.
 *
 * ## 국내 MAP 과 같은 타일·같은 색
 *
 * 색 규칙을 따로 만들면 국내 화면과 나란히 못 견준다. `map-tile` 을 그대로 쓰고
 * 색도 같은 식(5% 를 최대 강도로)으로 칠한다.
 *
 * ## 크기는 다 같다
 *
 * 국내 테마 MAP 은 시가총액으로 크기를 줄 수 있지만 **해외는 시가총액을 안 받아온다.**
 * 없는 걸 있는 척 크기로 만들면 거짓말이 되므로 칸을 똑같이 두고 색만 쓴다.
 */


function UsWatchMap({ onOpen }: { onOpen: (symbol: string, label: string) => void }) {
  /*
   * 그룹 계산은 **국내 MAP 과 같은 것을 쓴다.**
   *
   * 처음엔 여기서 직접 평균을 냈는데, 그러면 「테마/업종 MAP」의 관심종목(해외) 탭과
   * 숫자가 어긋날 수 있다 — 같은 그룹인데 화면마다 등락률이 다르면 어느 쪽을 믿어야
   * 할지 알 수 없다. 타일을 만드는 자리를 하나로 둔다.
   */
  const { tiles, loading } = useWatchGroupTiles("watchUs");
  const [target, setTarget] = useState<ConstituentTarget | null>(null);
  const { theme } = useAppearance();

  if (loading || tiles.length === 0) return null;

  return (
    <section className="ov-card">
      <div className="ov-card-h">
        <span className="ov-card-t">관심종목 MAP</span>
        <span className="ov-card-sub">{tiles.length}개 그룹</span>
      </div>
      <div className="ov-card-b">
        {/*
          타일을 누르면 **구성종목 시트**가 열린다.
          예전엔 아래 종목 타일로 스크롤만 시켰는데, 「테마/업종 MAP」은 같은 자리에서
          시트를 여는지라 같은 모양의 타일이 화면마다 다르게 움직이는 셈이었다.
        */}
        <div className="map-grid uwm-top">
          {[...tiles]
            .sort((a, b) => b.changeRate - a.changeRate)
            .map((t) => (
              <button
                key={t.id}
                className="map-tile"
                style={tileHeat(t.changeRate, theme)}
                onClick={() =>
                  setTarget({
                    kind: "custom",
                    code: t.id,
                    name: t.name,
                    label: "관심종목 그룹",
                    stocks: t.stocks,
                  })
                }
                title={t.name}
              >
                <span className="map-tile-name">{t.name}</span>
                <span className={`map-tile-pct num ${cls(t.changeRate)}`}>
                  {pct(t.changeRate)}
                </span>
                <span className="map-tile-sub">
                  ▲{t.risingCount}/▼{t.fallingCount}
                </span>
              </button>
            ))}
        </div>
        <div className="table-note">
          색이 진할수록 등락폭이 큽니다(5% 기준) · 타일을 누르면 <b>구성종목</b>이 열립니다 ·
          {tiles.length}개 그룹 · <b>▲/▼</b> 는 그 그룹에서 오른/내린 종목 수입니다 ·
          등락률은 <b>단순평균</b>입니다(해외는 시가총액을 안 받아옵니다).
          {/*
            타일과 아래 표가 다른 값을 낼 수 있다 — 층이 달라서다.
            안 적어 두면 「어느 쪽이 맞나」가 된다. 실제로 그 질문을 받았다.
          */}
          {" "}타일은 전일 종가 대비 <b>지금</b> 값이라 <b>시간외까지</b> 칩니다.
          아래 표의 등락률은 <b>정규장</b>만이고 시간외는 괄호에 따로 있습니다 —
          시간외에 크게 움직이면 둘이 다릅니다.
        </div>
      </div>

      {target && (
        <ConstituentSheet
          target={target}
          onClose={() => setTarget(null)}
          /* 해외 티커라 국내 상세로 보내면 못 찾는다 — 차트 시트를 연다 */
          onSelectStock={(code, name) => {
            setTarget(null);
            onOpen(code, name);
          }}
        />
      )}
    </section>
  );
}

/**
 * 섹터 MAP — **한 그룹의 종목을 타일로.**
 *
 * ## 왜 지수·ETF 인가
 *
 * 미국은 섹터가 ETF 로 거래된다 — `XLK`(기술) `XLF`(금융) `XLE`(에너지) 같은 것들이
 * 사실상 **섹터 그 자체**다. 국내 화면에서 업종 MAP 을 보는 것과 같은 일을 미국에서
 * 하려면 이 묶음을 타일로 펴 보는 게 가장 가깝다.
 *
 * 그룹 MAP 은 「어느 묶음이 도나」를 답하고, 여기는 **그 묶음 안에서 무엇이 끌었나**를
 * 답한다. 층이 다르므로 둘 다 있어야 한다.
 *
 * ## 그룹은 고를 수 있다
 *
 * 기본은 지수·ETF 지만 반도체나 바이오를 펴 보고 싶을 때가 있다. 고른 것은
 * 이 기기에 남는다 — 모니터마다 보는 자리가 다르다.
 */
/*
 * 섹터 MAP — **지수·ETF 와 액티브·테마 두 그룹만** (2026-08-25, 사용자 요청).
 *
 * 예전엔 그룹 선택 칩으로 아무 그룹이나 폈는데, 이 카드의 물음은 「오늘 어느
 * 업종이 셌나」 하나다 — 섹터 노릇을 하는 두 묶음만 붙박이로 편다.
 * 자리를 아끼려고 촘촘한 타일(dense)을 쓰고, ETF 는 ±2% 면 큰 날이라
 * 색 기준도 2% 로 낮춰 **강한 업종이 확실히 짙게** 보이게 한다.
 */
const SECTOR_GROUPS = ["지수·ETF", "액티브·테마"];

/**
 * 타일에 얹을 짧은 이름 (2026-08-27).
 *
 * ETF 정식명은 「SPDR Select Sector Fund - Materials」처럼 길고, 앞부분은 전부
 * 운용사·상품 형식이라 **뒤가 진짜 이름**이다. 흔한 접두를 걷어내고 남는 말만 쓴다.
 * 잘 알려진 것 몇은 한국어로 못 박아 둔다 — 「S&P 500」이 「SPDR S&P 500 ETF Trust」보다
 * 빨리 읽힌다. 사전에 없으면 정리한 영문을 그대로 쓴다(추측해서 지어내지 않는다).
 */
const ETF_KO: Record<string, string> = {
  SPY: "S&P 500",
  QQQ: "나스닥 100",
  IVV: "S&P 500",
  VOO: "S&P 500",
  DIA: "다우 30",
  IWM: "러셀 2000",
  SOXX: "반도체",
  SMH: "반도체",
  XLK: "기술",
  XLF: "금융",
  XLE: "에너지",
  XLV: "헬스케어",
  XLI: "산업재",
  XLY: "경기소비재",
  XLP: "필수소비재",
  XLB: "소재",
  XLU: "유틸리티",
  XLC: "커뮤니케이션",
  XLRE: "리츠",
  IBB: "바이오",
  XBI: "바이오(중소형)",
  IHI: "의료기기",
  ITA: "항공우주·방산",
  ITB: "주택건설",
  PAVE: "인프라",
  IGV: "소프트웨어",
  VGT: "기술",
  VYM: "고배당",
  VIG: "배당성장",
  IUSG: "미국 성장주",
  IUSV: "미국 가치주",
  HYG: "하이일드 채권",
  AMLP: "MLP(에너지 인프라)",
  VNQ: "리츠",
  EWY: "한국",
  EWJ: "일본",
  FXI: "중국 대형주",
  XME: "금속·광업",
  BOTZ: "로봇·AI",
  IDRV: "전기차·자율주행",
  FDN: "인터넷",
  CHAT: "AI·챗봇",
  ARKK: "혁신성장",
  TAN: "태양광",
  URA: "우라늄",
  LIT: "리튬·배터리",
};

function shortEtfName(raw: string): string {
  const ko = raw.trim();
  const cleaned = ko
    // 운용사·상품 형식 접두를 걷어낸다 — 남는 게 진짜 이름이다
    .replace(/^(SPDR|iShares|Invesco|Vanguard|Global X|ARK|VanEck|First Trust|Direxion|ProShares)\s+/i, "")
    .replace(/\b(ETF|Trust|Fund|Index|Shares?|Select Sector|Series)\b/gi, " ")
    .replace(/\s*[-–]\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || ko;
}

function UsSectorMap({ onOpen }: { onOpen: (symbol: string, label: string) => void }) {
  const { tiles, loading } = useWatchGroupTiles("watchUs");
  const { theme } = useAppearance();

  if (loading || tiles.length === 0) return null;
  const groups = SECTOR_GROUPS.map((n) => tiles.find((t) => t.name === n)).filter(
    (g): g is NonNullable<typeof g> => Boolean(g) && g!.stocks.length > 0,
  );
  if (groups.length === 0) return null;

  return (
    <section className="ov-card">
      <div className="ov-card-h">
        <span className="ov-card-t">섹터 MAP</span>
        <span className="ov-card-sub">{groups.map((g) => g.name).join(" · ")}</span>
      </div>
      <div className="ov-card-b">
        {groups.map((group) => (
          <div key={group.id} className="usm-sec">
            <div className="usm-sec-h">
              {group.name}
              {/* 이 묶음의 1등 — 훑기 전에 답부터 */}
              {(() => {
                const best = [...group.stocks].sort(
                  (a, b) => (b.changeRate ?? 0) - (a.changeRate ?? 0),
                )[0];
                return best ? (
                  <i className="usm-best">
                    최강 <b>{best.code}</b>
                    <em className={cls(best.changeRate)}> {pct(best.changeRate)}</em>
                  </i>
                ) : null;
              })()}
            </div>
            <div className="map-grid dense">
              {[...group.stocks]
                .sort((a, b) => (b.changeRate ?? 0) - (a.changeRate ?? 0))
                .map((s) => (
                  <button
                    key={s.code}
                    className="map-tile"
                    /* ETF 는 ±2% 가 큰 날 — 5% 기준으로 칠하면 전부 흐리다 */
                    style={tileHeat(s.changeRate, theme, 2)}
                    onClick={() => onOpen(s.code, s.name || s.code)}
                    title={`${s.code} · ${s.name}`}
                  >
                    {/* 티커가 먼저 — 미국은 티커로 기억한다 */}
                    <span className="map-tile-name">{s.code}</span>
                    <span className={`map-tile-pct num ${cls(s.changeRate)}`}>
                      {pct(s.changeRate)}
                    </span>
                    {/*
                      이름 한 줄 (2026-08-27 — "뭐가 뭔지 모르겠어").
                      XLB·IHI 처럼 티커만으로는 안 떠오르는 게 태반이다. 길면 말줄임하고
                      전체는 title 로 — 타일 폭은 그대로 두어 격자가 안 흐트러진다.
                    */}
                    {(ETF_KO[s.code] || (s.name && s.name !== s.code)) && (
                      <span className="map-tile-sub">{ETF_KO[s.code] ?? shortEtfName(s.name)}</span>
                    )}
                  </button>
                ))}
            </div>
          </div>
        ))}

        <div className="table-note">
          미국은 섹터가 ETF 로 거래되므로(XLK·XLF 같은) 이 두 묶음이 곧 업종 MAP 노릇을
          합니다. 등락률 순 · 색은 <b>±2% 기준</b>(ETF 는 2% 면 큰 날입니다) · 타일을
          누르면 상세가 열립니다. 이름은 마우스를 올리면 보입니다.
        </div>
      </div>
    </section>
  );
}

/**
 * 전광판 관심종목.
 *
 * 「관심종목(해외)」와 **같은 저장소**를 쓴다. 여기서 넣고 빼면 거기서도 바뀐다 —
 * 같은 목록을 두 곳에서 따로 관리하게 만들면 반드시 어긋난다.
 * 보여줄 그룹은 골라서 기억한다(기기별).
 */
const GROUP_KEY = "vntg.usboard.group";

function UsBoardWatch({ onOpen }: { onOpen: (symbol: string, label: string) => void }) {
  const [groups, setGroups] = useState<UsWatchGroup[]>([]);
  const [openId, setOpenId] = useState<string>(() => localStorage.getItem(GROUP_KEY) ?? "");
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<UsSearchResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 마지막으로 값을 받은 시각 — 안 적어 두면 살아 있는지 의심하게 된다 */
  const [at, setAt] = useState<number | null>(null);

  const load = useCallback(async (quiet = false) => {
    try {
      const r = await api.usWatch();
      setGroups(r.groups);
      setAt(Date.now());
      setError(null);
    } catch (e) {
      if (!quiet) setError(e instanceof Error ? e.message : "불러오지 못했습니다");
    }
  }, []);

  useEffect(() => {
    void load();
    // 미국장이 도는 동안 값이 움직인다. 20초면 전광판으로 충분하다
    const t = setInterval(() => void load(true), 20_000);
    return () => clearInterval(t);
  }, [load]);

  // 종목 검색
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setFound([]);
      return;
    }
    const t = setTimeout(() => {
      api
        .usWatchSearch(q)
        .then((r) => setFound(r.results))
        .catch(() => setFound([]));
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  const current = groups.find((g) => g.id === openId) ?? groups[0] ?? null;

  /*
   * 빠른 시세 오버레이 (2026-08-26 — 「시황 미국 탭이 실시간이 안 된다」).
   *
   * 관심종목(해외) 페이지에는 붙였는데 **여기(전광판)는 빠뜨렸다** — 같은 표를
   * 쓰면서 갱신은 20초(본 시세는 서버 1분 캐시)뿐이라 그 지적이 맞았다.
   * 같은 방식 그대로: 지금 보는 그룹만 야후 spark 배치로 3초(장중) 폴링해
   * 현재가·등락률을 덧씌운다. 탭이 뒤에 있으면 쉰다.
   */
  const openMarket = groups.some((g) => g.stocks.some((s) => (s.state ?? "").includes("실시간")));
  const [fast, setFast] = useState<Record<string, { price: number; changeRate: number | null; at: number }>>({});
  const fastSymbols = current?.stocks.map((s) => s.symbol).join(",") ?? "";
  useEffect(() => {
    if (!fastSymbols) return;
    let alive = true;
    const period = openMarket ? 3_000 : 30_000;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      api
        .usWatchFast(fastSymbols.split(","))
        .then((r) => alive && setFast(r.quotes))
        .catch(() => undefined);
    };
    tick();
    const t = setInterval(tick, period);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [fastSymbols, openMarket]);

  function pickGroup(id: string) {
    setOpenId(id);
    setPref(GROUP_KEY, id);
  }

  async function run(fn: () => Promise<{ groups: UsWatchGroup[] }>) {
    setBusy(true);
    setError(null);
    try {
      setGroups((await fn()).groups);
    } catch (e) {
      setError(e instanceof Error ? e.message : "실패");
    } finally {
      setBusy(false);
    }
  }

  /** 한 칸 위·아래로. 화면을 먼저 바꾸고 서버에 보낸다 */
  async function move(symbol: string, delta: -1 | 1) {
    if (!current) return;
    const order = current.stocks.map((s) => s.symbol);
    const at = order.indexOf(symbol);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= order.length) return;
    [order[at], order[to]] = [order[to], order[at]];
    setGroups((prev) =>
      prev.map((g) =>
        g.id === current.id
          ? { ...g, stocks: order.map((sym) => g.stocks.find((s) => s.symbol === sym)!) }
          : g,
      ),
    );
    await run(() => api.usWatchStockOrder(current.id, order));
  }

  return (
    <section className="ov-card">
      <div className="ov-card-h">
        <span className="ov-card-t">관심종목</span>
        <span className="ov-card-sub">
          {current ? `${current.stocks.length}종목` : ""}
          {at && ` · ${new Date(at).toLocaleTimeString("ko-KR", { hour12: false })}`}
        </span>
      </div>
      <div className="ov-card-b">
        {error && <div className="error-banner">{error}</div>}

        <div className="filter-row">
          {groups.map((g) => (
            <button
              key={g.id}
              className={`filter-btn ${current?.id === g.id ? "active" : ""}`}
              onClick={() => pickGroup(g.id)}
            >
              {g.name}
              <span className={`uw-grate ${cls(g.changeRate)}`}> {pct(g.changeRate)}</span>
            </button>
          ))}
          <button
            className={`filter-btn ${editing ? "active" : ""}`}
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "편집 끝" : "✏ 편집"}
          </button>
        </div>

        {editing && current && (
          <div className="search-box usb-add">
            <input
              className="search-input"
              placeholder={`「${current.name}」에 넣을 종목 — 티커나 이름으로`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query.trim() && found.length > 0 && (
              <div className="search-dropdown">
                {found.map((f) => (
                  <button
                    key={f.symbol}
                    className="search-result-row"
                    disabled={busy}
                    onClick={() => {
                      setQuery("");
                      setFound([]);
                      void run(() => api.usWatchStockAdd(current.id, f.symbol, f.name));
                    }}
                  >
                    <span className="name">{f.symbol}</span>
                    <span className="sub">
                      {f.name}
                      {f.exchange ? ` · ${f.exchange}` : ""}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {!current ? (
          <div className="page-note">
            그룹이 없습니다. <b>관심종목(해외)</b> 메뉴에서 먼저 만들어 주세요.
          </div>
        ) : current.stocks.length === 0 ? (
          <div className="page-note">
            담긴 종목이 없습니다. <b>✏ 편집</b>을 켜고 검색해서 넣으세요.
          </div>
        ) : (
          /*
            ⚠️ 예전엔 카드를 **옆으로 늘어놓았다.** 한 줄에 셋씩 들어가니 종목끼리
            줄이 안 맞아서, 어느 게 많이 빠졌는지 눈으로 훑을 수가 없었다.
            관심종목(해외) 메뉴와 **같은 표**를 쓴다 — 값이 갈라질 일도 없어진다.
          */
          <UsWatchTable
            stocks={current.stocks}
            fast={fast}
            editing={editing}
            onOpen={onOpen}
            onMove={(symbol, d) => void move(symbol, d)}
            onRemove={(symbol) => void run(() => api.usWatchStockRemove(current.id, symbol))}
          />
        )}

        {/*
          ⚠️ 여기에 「한국 저녁이면 **프리장**, 새벽 마감 뒤엔 애프터장, 한국 낮엔 주간거래」
          라고 세 경우를 나열해 놨었다. 조건을 설명한 문장인데 **첫 낱말이 굵어서**
          「지금 프리장」으로 읽혔다 — 실제로 애프터장 시간에 프리장이 뜬다는 말이 나왔다.
          지금 도는 세션 하나만 이름으로 적고, 나머지는 굵게 쓰지 않는다.
        */}
        <div className="table-note">
          <b>관심종목(해외)</b> 와 같은 목록입니다 — 여기서 넣고 빼면 거기서도 바뀝니다.
          종목을 누르면 <b>상세</b>가 열립니다.
          등락률은 <b>전일 종가 대비</b>고, 괄호는 지금 도는{" "}
          <b>{sideNameOf(current?.stocks ?? [])}</b> 입니다.
          정규장 중에는 괄호가 사라집니다(그때는 지금 값이 곧 정규장입니다).
        </div>
      </div>
    </section>
  );
}

/**
 * 전광판 맨 위 신호등.
 *
 * 색 하나로 끝내지 않고 **왜 그런지**를 같이 낸다. 「빨강」만 있으면 무엇을 봐야 할지 모른다.
 */
function BoardLight({ sig }: { sig: UsBoardSignal }) {
  const label = sig.level === "red" ? "주의" : sig.level === "yellow" ? "보통" : "무난";
  return (
    <section className={`ov-card usb-light ${sig.level}`}>
      <div className="ov-card-b usb-light-b">
        <span className={`sig-dot big ${sig.level}`} />
        <span className="usb-light-lv">{label}</span>
        <span className="usb-light-sum">{sig.summary}</span>
        {sig.reasons.length > 0 && (
          <details className="usb-light-why">
            <summary>이유 {sig.reasons.length}</summary>
            <ul>
              {sig.reasons.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}
