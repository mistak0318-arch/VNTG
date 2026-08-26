import { useEffect, useState } from "react";
import { FONTS, FONT_SCALES, GLOBAL_KEY, useAppearance, WIDTHS } from "../useAppearance";
import { setPref } from "../prefs";
import { api, fmtNum, type ProviderUsage, type UsageTotals } from "../api";
import { RefreshBar } from "../components/RefreshBar";
import { AiModelPanel } from "../components/AiModelPanel";
import { AlertConfigPanel } from "../components/AlertConfigPanel";
import { CollapsibleCard } from "../components/CollapsibleCard";
import { ReportSchedulePanel } from "../components/ReportSchedulePanel";
import { ChartConfigPanel } from "../components/ChartConfigPanel";
import { MenuOrderPanel } from "../components/MenuOrderPanel";
import { CardOrderPanel } from "../components/CardOrderPanel";
import { ScreenLockPanel } from "../components/ScreenLockPanel";
import { MENU_ITEMS } from "../App";
import { ChannelCollectPanel } from "../components/ChannelCollectPanel";
import { SignalConfigPanel } from "../components/SignalConfigPanel";
import { TelegramOverviewPanel } from "../components/TelegramOverviewPanel";
import { SubTabOrderPanel } from "../components/SubTabOrderPanel";

interface KeyInfo {
  name: string;
  configured: boolean;
}

/** 사용률에 따라 색을 바꿔 한도 임박을 눈에 띄게 */
function rateColor(rate: number | null): string {
  if (rate === null) return "var(--muted)";
  if (rate >= 90) return "var(--red)";
  if (rate >= 70) return "#f5c542";
  return "var(--green)";
}

/**
 * 설정 탭.
 *
 * 카드 열한 개가 한 화면에 쌓여 있으니 찾는 게 일이었다. 성격이 전혀 다른 것들이
 * 섞여 있었다 — 화면 꾸미기와 API 비용을 같은 목록에서 스크롤로 찾을 이유가 없다.
 */
type SettingsTab = "display" | "analysis" | "publish" | "cost";

const SETTINGS_TABS: { key: SettingsTab; label: string; hint: string }[] = [
  { key: "display", label: "화면", hint: "메뉴 순서 · 테마 · 글꼴" },
  { key: "analysis", label: "분석 기준", hint: "신호등 기준 · AI 모델" },
  { key: "publish", label: "발행·알림", hint: "리포트 일정 · 채널 수집 · 시그널" },
  { key: "cost", label: "비용·상태", hint: "AI 비용 · API 사용량 · 키 상태" },
];

export function SettingsPage() {
  const appearance = useAppearance();
  /** 전체 설정 저장/불러오기의 결과 한 줄 */
  const [globalMsg, setGlobalMsg] = useState<string | null>(null);
  const [tab, setTab] = useState<SettingsTab>("display");

  const [usage, setUsage] = useState<ProviderUsage[]>([]);
  const [day, setDay] = useState("");
  const [history, setHistory] = useState<{ day: string; counts: Record<string, number> }[]>([]);
  const [totals, setTotals] = useState<UsageTotals | null>(null);
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [isMock, setIsMock] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [u, h, k, t] = await Promise.all([
        api.apiUsage(),
        api.apiUsageHistory(14),
        api.apiKeys(),
        api.apiUsageTotals(30).catch(() => null),
      ]);
      setUsage(u.providers);
      setDay(u.day);
      setHistory(h.history);
      setTotals(t);
      setKeys(k.keys);
      setIsMock(k.isMock);
    } catch (err) {
      setError(err instanceof Error ? err.message : "알 수 없는 오류");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div>
      <nav className="detail-tabs">
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.key}
            className={`detail-tab${tab === t.key ? " active" : ""}`}
            onClick={() => setTab(t.key)}
            title={t.hint}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <p className="page-note">{SETTINGS_TABS.find((t) => t.key === tab)?.hint}</p>

      {tab === "display" && (
      <CollapsibleCard
        id="menuOrder"
        title="메뉴 순서·표시"
        hint="사이드바 메뉴를 원하는 순서로 바꾸고 안 쓰는 것은 숨깁니다."
      >
        <MenuOrderPanel items={MENU_ITEMS} />
      </CollapsibleCard>
      )}

      {/*
        카드 배치는 여기 있어야 한다.
        예전엔 대시보드 탭 바에 「배치」 버튼이 늘 붙어 있었는데, 한 번 정하면 끝나는 값이
        매일 보는 화면의 맨 윗줄을 차지할 이유가 없다.
      */}
      {tab === "display" && (
      <CollapsibleCard
        id="cardOrder"
        title="시황 카드 순서"
        hint="시황 대시보드의 카드를 원하는 차례로 놓습니다."
      >
        <CardOrderPanel />
      </CollapsibleCard>
      )}

      {tab === "display" && (
      <CollapsibleCard
        id="subTabOrder"
        title="서브탭 순서"
        hint="각 메뉴 상단의 서브탭을 원하는 차례로 놓습니다."
      >
        <SubTabOrderPanel />
      </CollapsibleCard>
      )}

      {tab === "display" && (
      <CollapsibleCard
        id="screenLock"
        title="화면 잠금"
        hint="자리를 비운 사이 화면을 가립니다. 이 기기에만 저장됩니다."
      >
        <ScreenLockPanel />
      </CollapsibleCard>
      )}

      {tab === "display" && (
      <CollapsibleCard
        id="chartConfig"
        title="차트"
        hint="이동평균선·볼린저 밴드·매물대·말풍선을 내 방식대로 맞춥니다."
      >
        <ChartConfigPanel />
      </CollapsibleCard>
      )}

      {/*
        발송 전수 현황이 맨 위 (2026-08-26) — 텔레그램으로 나가는 여덟 갈래의 설정이
        설정·텔레그램 동향·.env 세 곳에 흩어져 있어, 「뭐가 어디로 가는지」부터
        한 자리에서 보이게 한다. 각 행이 해당 설정의 위치를 안내한다.
      */}
      {tab === "publish" && (
      <CollapsibleCard
        id="telegramOverview"
        title="텔레그램 발송 한눈에"
        hint="무엇이 언제 어느 방으로 가는지 — 발송 전체 지도"
        defaultOpen
      >
        <TelegramOverviewPanel />
      </CollapsibleCard>
      )}

      {tab === "publish" && (
      <CollapsibleCard
        id="reportSchedule"
        title="리포트 발행 일정"
        hint="언제 몇 판을 낼지 직접 정합니다. 판을 추가·삭제할 수 있습니다."
      >
        <ReportSchedulePanel />
      </CollapsibleCard>
      )}

      {tab === "analysis" && (
      <CollapsibleCard
        id="aiModels"
        title="AI 모델"
        hint="데일리 리포트·채널 요약에 어떤 모델을 쓸지 고릅니다."
      >
        <p className="page-note">
          용도마다 <b>호출 빈도가 달라서</b> 같은 모델이라도 월 비용이 몇 배씩 벌어집니다.
          품질이 중요한 것만 좋은 모델을 쓰고 나머지는 저렴한 쪽으로 두는 게 요령입니다.
        </p>
        <AiModelPanel />
      </CollapsibleCard>
      )}

      {tab === "publish" && (
      <CollapsibleCard
        id="channels"
        title="구독 채널 수집 (텔레그램)"
        hint="구독 채널을 읽어 여러 채널이 동시에 말하는 것을 뽑아냅니다."
      >
        <p className="page-note">
          내가 구독 중인 텔레그램 채널을 읽어서 <b>여러 채널이 동시에 말하고 있는 것</b>을
          뽑아냅니다. 채널 하나가 떠드는 건 노이즈지만, 열 개가 같은 종목을 말하면 신호입니다.
        </p>
        <ChannelCollectPanel />
      </CollapsibleCard>
      )}

      {tab === "publish" && (
      <CollapsibleCard
        id="alerts"
        title="관심종목 시그널 (텔레그램)"
        hint="장중에 관심종목이 조건에 걸리면 시그널 방으로 알립니다."
      >
        <p className="page-note">
          장중에 관심종목이 조건에 걸리면 텔레그램 시그널 방으로 알립니다.
          알림은 많아지면 무시하게 되므로, 기준값을 올려 <b>덜 울리게</b> 맞추는 게 요령입니다.
        </p>
        <AlertConfigPanel />
      </CollapsibleCard>
      )}

      {tab === "analysis" && (
      <CollapsibleCard
        id="signal"
        title="신호등 기준"
        hint="종목명 옆 신호등이 켜지는 기준을 내 매매 기준에 맞춥니다."
      >
        <p className="page-note">
          종목명 옆 신호등이 어떤 기준으로 켜지는지 정합니다. 내 매매 기준을 여기에 적어두고,
          맞지 않으면 계속 고쳐가면서 쓰는 것이 이 기능의 목적입니다.
        </p>
        <SignalConfigPanel />
      </CollapsibleCard>
      )}

      {tab === "display" && (
      <CollapsibleCard
        id="appearance"
        title="화면 설정"
        hint="테마 · 글꼴 · 글자 크기 · 메뉴바 위치"
        defaultOpen
      >

        <div className="appearance-row">
          <span className="appearance-label">테마</span>
          <div className="filter-row" style={{ margin: 0 }}>
            {([
              { key: "dark" as const, label: "다크" },
              { key: "light" as const, label: "라이트" },
              { key: "excel" as const, label: "엑셀" },
            ]).map((t) => (
              <button
                key={t.key}
                className={`filter-btn ${appearance.theme === t.key ? "active" : ""}`}
                onClick={() => appearance.set({ theme: t.key })}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        {appearance.theme === "excel" && (
          <div className="st-cfg-note">
            엑셀 모드는 <b>리본·행번호·시트탭</b>까지 붙여 스프레드시트처럼 보이게 합니다.
            글꼴은 맑은 고딕으로 고정되고(고르신 글꼴은 그대로 저장돼 있습니다), 아래 시트 탭은
            <b> 자주 쓰는 메뉴</b>로 채워집니다. 메뉴 맨 아래 <b>📊</b> 버튼으로 바로 껐다 켤 수
            있습니다.
          </div>
        )}

        <div className="appearance-row">
          <span className="appearance-label">글꼴</span>
          <select
            className="group-select"
            style={{ maxWidth: 180 }}
            value={appearance.font}
            onChange={(e) => appearance.set({ font: e.target.value as typeof appearance.font })}
          >
            {FONTS.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </div>

        <div className="appearance-row">
          <span className="appearance-label">글자 크기</span>
          <div className="filter-row" style={{ margin: 0 }}>
            {FONT_SCALES.map((sc) => (
              <button
                key={sc}
                className={`filter-btn ${appearance.fontScale === sc ? "active" : ""}`}
                onClick={() => appearance.set({ fontScale: sc })}
              >
                {sc}%
              </button>
            ))}
          </div>
        </div>

        <div className="appearance-row">
          <span className="appearance-label">메뉴바 위치</span>
          <div className="filter-row" style={{ margin: 0 }}>
            {([
              { key: "left" as const, label: "왼쪽" },
              { key: "right" as const, label: "오른쪽" },
            ]).map((t) => (
              <button
                key={t.key}
                className={`filter-btn ${appearance.navSide === t.key ? "active" : ""}`}
                onClick={() => appearance.set({ navSide: t.key })}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        {/* 왜 있는 기능인지 적어 둔다 — 취향이 아니라 한 손 조작 때문이다 */}
        <div className="table-note">
          한 손으로 폰을 쥐면 엄지가 닿는 쪽이 정해져 있습니다. 오른쪽으로 옮기면
          드로어가 열리는 방향과 ☰ 버튼 자리도 같이 넘어갑니다.
        </div>

        {/* 사이드바 자동숨김 (2026-08-25, PDF #2) — PC 에서도 드로어로 */}
        <div className="appearance-row">
          <span className="appearance-label">사이드바 자동숨김</span>
          <div className="filter-row" style={{ margin: 0 }}>
            {([
              { key: false, label: "고정" },
              { key: true, label: "자동숨김" },
            ] as const).map((t) => (
              <button
                key={String(t.key)}
                className={`filter-btn ${appearance.sidebarAuto === t.key ? "active" : ""}`}
                onClick={() => appearance.set({ sidebarAuto: t.key })}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="table-note">
          자동숨김을 켜면 PC 에서도 사이드바가 상시로 안 붙고 <b>◐ 버튼으로 여는
          드로어</b>가 됩니다 — 본문이 그만큼 넓어집니다. 시세분석처럼 열 많은 표를
          주로 볼 때 씁니다.
        </div>

        <div className="appearance-row">
          <span className="appearance-label">화면 폭</span>
          <div className="filter-row" style={{ margin: 0 }}>
            {WIDTHS.map((w) => (
              <button
                key={w.key}
                className={`filter-btn ${appearance.width === w.key ? "active" : ""}`}
                onClick={() => appearance.set({ width: w.key })}
                title={w.hint}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
        <div className="table-note">
          본문이 <b>1400px 로 못 박혀</b> 있었습니다 — 울트라와이드에서는 표가 옆으로
          잘리는데 오른쪽은 통째로 노는 꼴이었습니다. 시세분석처럼 <b>열이 많은 화면</b>은
          「넓게」나 「화면 전체」가 낫고, 가이드·리포트처럼 <b>글이 많은 화면</b>은
          한 줄이 너무 길면 눈이 줄을 놓치니 「보통」이 낫습니다.
          <b> 보드는 이 설정과 무관하게</b> 늘 화면을 다 씁니다.
        </div>

        <div className="font-preview">
          미리보기 — 삼성전자 <span className="num positive">+6.68%</span> / SK하이닉스{" "}
          <span className="num negative">-1.23%</span> · 거래대금 <span className="num">6,282</span>억
        </div>

        {/*
          전체 설정 (2026-08-25, PDF #1) — 화면설정은 기기별이 기본인데(27인치 글자
          크기가 폰까지 따라오면 안 된다), 한 번에 전 기기에 적용하고 싶을 때가 있다.
          그래서 서버에 「전체 기본」 한 판을 두고, 밀고(저장) 당기는(불러오기) 버튼을 준다.
          처음 여는 기기는 전체 기본으로 시작한다.
        */}
        <div className="appearance-row">
          <span className="appearance-label">전체 설정</span>
          <div className="filter-row" style={{ margin: 0 }}>
            <button
              className="filter-btn"
              onClick={() => {
                setPref(GLOBAL_KEY, JSON.stringify({
                  theme: appearance.theme,
                  font: appearance.font,
                  fontScale: appearance.fontScale,
                  navSide: appearance.navSide,
                  width: appearance.width,
                  sidebarAuto: appearance.sidebarAuto,
                }));
                setGlobalMsg("지금 화면설정을 전체 기본으로 저장했습니다 — 다른 기기에서 「전체 기본 불러오기」로 받습니다.");
              }}
              title="지금 이 화면설정을 서버에 저장합니다 — 모든 기기의 기본이 됩니다"
            >
              모든 기기의 기본으로 저장
            </button>
            <button
              className="filter-btn"
              onClick={() => {
                try {
                  const raw = localStorage.getItem(GLOBAL_KEY);
                  if (!raw) {
                    setGlobalMsg("저장된 전체 기본이 아직 없습니다 — 먼저 어느 기기에서든 저장해 주세요.");
                    return;
                  }
                  appearance.set(JSON.parse(raw) as Parameters<typeof appearance.set>[0]);
                  setGlobalMsg("전체 기본을 이 기기에 적용했습니다.");
                } catch {
                  setGlobalMsg("전체 기본을 읽지 못했습니다.");
                }
              }}
              title="서버에 저장된 전체 기본을 이 기기에 적용합니다"
            >
              전체 기본 불러오기
            </button>
          </div>
        </div>
        {globalMsg && <div className="alert-note">{globalMsg}</div>}
        <div className="table-note">
          화면설정은 <b>기기별</b>이 기본입니다 — 27인치에 맞춘 글자 크기가 폰까지
          따라오면 안 되니까요. <b>전체 기본</b>은 서버에 두는 공용 한 판입니다:
          여기서 저장하면 다른 기기에서 불러오거나, <b>처음 여는 기기</b>는 자동으로
          그 설정으로 시작합니다.
        </div>
      </CollapsibleCard>
      )}

      {tab === "cost" && <RefreshBar onRefresh={load} loading={loading} />}

      {error && <div className="error-banner">{error}</div>}

      {tab === "cost" && totals && (
        <CollapsibleCard
          id="aiCost"
          title={`AI 비용 (최근 ${totals.days}일)`}
          hint="어느 메뉴가 얼마를 쓰는지 · 모델별 내역"
        >
          <div className="cost-head">
            <span className="cost-total num">${totals.estimatedUsd.toFixed(2)}</span>
            <span className="cost-range">
              {totals.from} ~ {totals.to}
            </span>
          </div>

          <p className="page-note">
            공개 단가로 계산한 <b>추정치</b>입니다. 캐시 토큰(쓰기 1.25배 · 읽기 0.1배)과
            웹 검색 건당 요금까지 반영하지만, 실제 청구액은 Anthropic Console에서 확인하세요.
            잔여 크레딧은 어떤 API로도 조회되지 않습니다.
            {totals.hasLegacy && (
              <>
                {" "}
                <b>
                  ⚠ 기능별 집계가 생기기 전에 쌓인 기록이 섞여 있어 그만큼은 「기타」로 잡힙니다.
                </b>{" "}
                지금부터 쌓이는 호출은 메뉴별로 갈립니다.
              </>
            )}
          </p>

          <div className="cost-cols">
            <div>
              <div className="cost-sub">메뉴별</div>
              {totals.byFeature.length === 0 && <div className="empty">기록 없음</div>}
              {totals.byFeature.map((f) => (
                <div className="cost-row" key={f.feature}>
                  <span className="cost-name">{f.label}</span>
                  <span className="cost-bar-wrap">
                    <span
                      className="cost-bar"
                      style={{
                        width: `${totals.estimatedUsd > 0 ? (f.usd / totals.estimatedUsd) * 100 : 0}%`,
                      }}
                    />
                  </span>
                  <span className="num cost-usd">${f.usd.toFixed(2)}</span>
                  <span className="num cost-calls">{f.calls > 0 ? `${f.calls}회` : "-"}</span>
                </div>
              ))}
            </div>

            <div>
              <div className="cost-sub">모델별</div>
              {totals.byModel.map((m) => (
                <div className="cost-row" key={m.model}>
                  <span className="cost-name">{m.model}</span>
                  <span className="cost-bar-wrap">
                    <span
                      className="cost-bar alt"
                      style={{
                        width: `${totals.estimatedUsd > 0 ? (m.usd / totals.estimatedUsd) * 100 : 0}%`,
                      }}
                    />
                  </span>
                  <span className="num cost-usd">${m.usd.toFixed(2)}</span>
                  <span className="num cost-calls">
                    {fmtNum(Math.round((m.input + m.output) / 1000))}K
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="cost-sub" style={{ marginTop: 12 }}>
            일별
          </div>
          <div className="cost-days">
            {totals.byDay.map((d) => (
              <div className="cost-day" key={d.day} title={`${d.day} · $${d.usd.toFixed(4)}`}>
                <span
                  className="cost-day-bar"
                  style={{
                    height: `${Math.max(2, (d.usd / Math.max(...totals.byDay.map((x) => x.usd), 0.0001)) * 40)}px`,
                  }}
                />
                <span className="cost-day-label">{d.day.slice(5)}</span>
              </div>
            ))}
          </div>
        </CollapsibleCard>
      )}

      {tab === "cost" && (
      <CollapsibleCard
        id="usage"
        title={`API 사용량${day ? ` (${day})` : ""}`}
        hint="키움 · DART · 네이버 · Claude 호출량과 추정 비용"
      >
        <div className="usage-grid">
          {usage.map((p) => (
            <div className="usage-card" key={p.provider}>
              <div className="usage-head">
                <span className="usage-label">{p.label}</span>
                <span className="usage-count num">
                  {fmtNum(p.total)}
                  {p.limit ? ` / ${fmtNum(p.limit)}` : ""}
                </span>
              </div>

              {p.limit !== null ? (
                <>
                  <div className="progress-bar">
                    <div
                      className="progress-bar-fill"
                      style={{
                        width: `${Math.min(p.usageRate ?? 0, 100)}%`,
                        background: rateColor(p.usageRate),
                      }}
                    />
                  </div>
                  <div className="usage-rate" style={{ color: rateColor(p.usageRate) }}>
                    {(p.usageRate ?? 0).toFixed(2)}% 사용
                  </div>
                </>
              ) : (
                <div className="usage-rate">일일 총량 제한 없음</div>
              )}

              {/* Claude는 호출 수가 아니라 토큰이 비용이므로 따로 강조해서 보여준다 */}
              {p.tokens && (
                <div className="token-box">
                  <div className="token-row">
                    <span>입력 토큰</span>
                    <span className="num">{fmtNum(p.tokens.input)}</span>
                  </div>
                  <div className="token-row">
                    <span>출력 토큰</span>
                    <span className="num">{fmtNum(p.tokens.output)}</span>
                  </div>
                  <div className="token-row cost">
                    <span>추정 비용</span>
                    <span className="num">${p.tokens.estimatedUsd.toFixed(4)}</span>
                  </div>
                </div>
              )}

              <div className="usage-stats">
                <span>성공 {fmtNum(p.ok)}</span>
                <span className={p.failed > 0 ? "negative" : ""}>
                  실패 {fmtNum(p.failed)}
                  {/* 비율이 붙어야 심각한지 아닌지가 보인다. 3,700건이 27%인지 3%인지는 다른 얘기다 */}
                  {p.total > 0 && p.failed > 0 && ` (${((p.failed / p.total) * 100).toFixed(0)}%)`}
                </span>
                <span className={p.rateLimited > 0 ? "negative" : ""}>
                  한도초과 {fmtNum(p.rateLimited)}
                </span>
              </div>

              {/*
                실패 사유. 개수만 세면 **무엇을 고쳐야 할지 알 수가 없다** —
                한투가 하루 3,700건씩 실패했는데 그게 종목이 없어서인지 토큰이
                만료돼서인지 유량인지 구분이 안 됐다.
              */}
              {(p.failReasons ?? []).length > 0 && (
                <details className="usage-detail">
                  <summary>실패 사유 ({p.failReasons.length})</summary>
                  <table className="data-table" style={{ width: "100%" }}>
                    <tbody>
                      {p.failReasons.map((f) => (
                        <tr key={f.reason}>
                          <td>{f.reason}</td>
                          <td className="num">{fmtNum(f.count)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}

              <div className="usage-note">{p.note}</div>

              {/*
                AI provider 는 모델명만 나열하면 소용이 없다 — "claude-sonnet-5 20회"만
                봐서는 리포트가 쓴 건지 채널 요약이 쓴 건지 알 수 없다. 어느 메뉴가
                불렀는지를 앞세우고 모델은 옆에 붙인다.
              */}
              {p.tokens && p.tokens.detail.length > 0 ? (
                <details className="usage-detail">
                  <summary>호출 내역 — 메뉴별 ({p.tokens.detail.length})</summary>
                  <table className="data-table" style={{ width: "100%" }}>
                    <tbody>
                      {p.tokens.detail.map((d) => (
                        <tr key={`${d.feature}|${d.model}`}>
                          <td className="sticky-col" style={{ position: "static" }}>
                            <b>{d.label}</b>
                            <span className="usage-model"> {d.model}</span>
                          </td>
                          <td className="num">{fmtNum(d.calls)}회</td>
                          <td className="num">${d.usd.toFixed(4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              ) : (
                p.topEndpoints.length > 0 && (
                  <details className="usage-detail">
                    <summary>호출 내역 (상위 {p.topEndpoints.length})</summary>
                    <table className="data-table" style={{ width: "100%" }}>
                      <tbody>
                        {p.topEndpoints.map((e) => (
                          <tr key={e.endpoint}>
                            <td className="sticky-col" style={{ position: "static" }}>
                              {e.endpoint}
                            </td>
                            <td>{fmtNum(e.count)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                )
              )}
            </div>
          ))}
        </div>
      </CollapsibleCard>
      )}

      {tab === "cost" && history.length > 0 && (
        <CollapsibleCard id="history" title="최근 호출 추이" hint="최근 14일 일별 호출 수">
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="sticky-col">일자</th>
                  <th>키움</th>
                  <th>DART</th>
                  <th>네이버</th>
                  <th>합계</th>
                </tr>
              </thead>
              <tbody>
                {[...history].reverse().map((h) => {
                  const total = (h.counts.kiwoom ?? 0) + (h.counts.dart ?? 0) + (h.counts.naver ?? 0);
                  return (
                    <tr key={h.day}>
                      <td className="sticky-col">{h.day.slice(5)}</td>
                      <td>{fmtNum(h.counts.kiwoom ?? 0)}</td>
                      <td>{fmtNum(h.counts.dart ?? 0)}</td>
                      <td>{fmtNum(h.counts.naver ?? 0)}</td>
                      <td className="strong-col">{fmtNum(total)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CollapsibleCard>
      )}

      {tab === "cost" && (
      <CollapsibleCard id="keys" title="API 키 설정 상태" hint="키 설정 여부와 거래 모드">
        <div className="key-list">
          {keys.map((k) => (
            <div className="key-row" key={k.name}>
              <span className="key-name">{k.name}</span>
              <span className={k.configured ? "key-ok" : "key-missing"}>
                {k.configured ? "설정됨" : "미설정"}
              </span>
            </div>
          ))}
          <div className="key-row">
            <span className="key-name">거래 모드</span>
            <span className={isMock ? "key-ok" : "key-missing"}>{isMock ? "모의투자" : "실전투자"}</span>
          </div>
        </div>
        <div className="table-note">
          키 값은 서버 밖으로 나가지 않습니다. 설정 여부만 표시합니다 · 값 변경은 server/.env 파일에서 직접
        </div>
      </CollapsibleCard>
      )}
    </div>
  );
}
