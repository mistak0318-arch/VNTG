import { useState } from "react";
import { useCardOrder } from "../useCardOrder";
import { ChannelCollectPanel } from "../components/ChannelCollectPanel";
import { ChannelDigestPanel } from "../components/ChannelDigestPanel";
import { ChannelSearchPanel } from "../components/ChannelSearchPanel";
import { PickAutoPanel } from "../components/PickAutoPanel";
import { AiModelPanel } from "../components/AiModelPanel";
import { KeywordAlertPanel } from "../components/KeywordAlertPanel";
import { DisclosureAlertPanel } from "../components/DisclosureAlertPanel";

/**
 * 텔레그램 동향.
 *
 * 설정 화면 한구석에 있던 것을 대메뉴로 뺐다. 이건 "설정"이 아니라 **정보원**이다 —
 * 구독 중인 200여 개 채널이 지금 무슨 말을 하고 있는지가 다른 어떤 지표보다 빠를 때가 있다.
 *
 * 두 축으로 나눴다.
 *   동향 — 지금 무엇이 돌고 있는가 (수집·선별·AI 정리)
 *   채널 — 어디를 읽을 것인가 (구독 목록 켜고 끄기)
 */

type Tab = "digest" | "search" | "keyword" | "disclosure" | "channels" | "pick" | "ai";

export const TELEGRAM_TABS: { key: Tab; label: string; hint: string }[] = [
  { key: "digest", label: "동향", hint: "지금 채널들이 무슨 말을 하고 있는지" },
  /*
   * 검색 — 보드(창 연동)에만 있던 것을 여기로도 꺼냈다.
   * 「동향」은 채널 전체가 무슨 말을 하나이고, 검색은 **내가 궁금한 말이 어디서
   * 언급됐나**다. 보드는 여러 모니터 쓸 때 얘기라, 폰에서는 이 탭이 그 자리다.
   */
  { key: "search", label: "🔎 검색", hint: "원하는 말을 채널 전체에서 찾습니다 — 종목이든 키워드든" },
  { key: "keyword", label: "내 관심 키워드", hint: "내 종목·키워드가 걸리면 바로 알립니다" },
  { key: "disclosure", label: "공시 알림", hint: "내 종목 공시가 뜨면 바로 알립니다" },
  { key: "channels", label: "채널 관리", hint: "어느 채널을 읽을지 고릅니다" },
  { key: "pick", label: "선별 관리", hint: "AI 없이 원문 그대로 자동 발송 (비용 없음)" },
  { key: "ai", label: "AI 관리", hint: "AI 정리를 어떤 모델로 할지" },
];

export function TelegramPage() {
  const [tab, setTab] = useState<Tab>("digest");
  /* 탭 순서 — 설정 > 서브탭 순서에서 바꾼다(서버 저장) */
  const tabOrder = useCardOrder(
    "telegram.tabs",
    TELEGRAM_TABS.map((t) => t.key),
  );

  return (
    <div>
      <nav className="detail-tabs">
        {TELEGRAM_TABS.map((t) => (
          <button
            key={t.key}
            className={`detail-tab${tab === t.key ? " active" : ""}`}
            style={{ order: tabOrder.orderOf(t.key) }}
            onClick={() => setTab(t.key)}
            title={t.hint}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "digest" && <ChannelDigestPanel />}
      {tab === "search" && <ChannelSearchPanel />}
      {tab === "keyword" && <KeywordAlertPanel />}
      {tab === "disclosure" && <DisclosureAlertPanel />}
      {tab === "channels" && <ChannelCollectPanel />}
      {tab === "pick" && <PickAutoPanel />}
      {tab === "ai" && (
        <>
          <p className="page-note">
            AI 정리는 <b>호출당 비용</b>이 있어 자동 발송을 걸지 않았습니다. 정기 발행(07/12/18시)과
            「AI로 정리」 버튼으로만 돕니다. 어떤 모델을 쓸지는 아래에서 고릅니다.
          </p>
          <AiModelPanel />
        </>
      )}
    </div>
  );
}
