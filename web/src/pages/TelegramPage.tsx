import { useState } from "react";
import { ChannelCollectPanel } from "../components/ChannelCollectPanel";
import { ChannelDigestPanel } from "../components/ChannelDigestPanel";

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

type Tab = "digest" | "channels";

const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: "digest", label: "동향", hint: "지금 채널들이 무슨 말을 하고 있는지" },
  { key: "channels", label: "채널 관리", hint: "어느 채널을 읽을지 고릅니다" },
];

export function TelegramPage() {
  const [tab, setTab] = useState<Tab>("digest");

  return (
    <div>
      <nav className="detail-tabs">
        {TABS.map((t) => (
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

      {tab === "digest" ? <ChannelDigestPanel /> : <ChannelCollectPanel />}
    </div>
  );
}
