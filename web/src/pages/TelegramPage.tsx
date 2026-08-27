import { useState } from "react";
import { useCardOrder } from "../useCardOrder";
import { ChannelDigestPanel } from "../components/ChannelDigestPanel";
import { ChannelSearchPanel } from "../components/ChannelSearchPanel";
import { MajorChannelPanel } from "../components/MajorChannelPanel";
import { TelegramRoomsPanel, TelegramStarsPanel } from "../components/TelegramRoomsPanel";

/**
 * 텔레그램 동향.
 *
 * 이건 "설정"이 아니라 **정보원**이다 — 구독 중인 200여 개 채널이 지금 무슨 말을
 * 하고 있는지가 다른 어떤 지표보다 빠를 때가 있다.
 *
 * ## 2026-08-27 재편 — "설정이랑 기능이랑 섞여 있잖아"
 *
 * 키워드·공시 알림, 채널 관리, 선별, AI 관리는 **설정 > 발행·알림**으로 이사했다
 * (채널 관리·AI 는 원래 설정에도 있어 중복이었다). 여기는 읽는 자리만 남긴다:
 *   받은 방 — 봇이 보낸 VNTG 방들을 브라우저에서 텔레그램처럼 (안읽음 말풍선·별표)
 *   동향   — 구독 채널들이 지금 무슨 말을 하나
 *   검색   — 그 말이 어디서 언급됐나
 *   중요   — 별표로 집은 메시지 보관함
 */

type Tab = "rooms" | "digest" | "major" | "search" | "stars";

export const TELEGRAM_TABS: { key: Tab; label: string; hint: string }[] = [
  { key: "rooms", label: "받은 방", hint: "VNTG 방 6곳 — 안읽음 말풍선, 열면 대화방처럼" },
  { key: "digest", label: "동향", hint: "지금 채널들이 무슨 말을 하고 있는지" },
  { key: "major", label: "주요 채널", hint: "골라 둔 채널의 글을 빠짐없이 원문 그대로" },
  { key: "search", label: "🔎 검색", hint: "원하는 말을 채널 전체에서 찾습니다 — 종목이든 키워드든" },
  { key: "stars", label: "⭐ 중요 메시지", hint: "받은 방에서 별표한 것들" },
];

export function TelegramPage() {
  const [tab, setTab] = useState<Tab>("rooms");
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

      {tab === "rooms" && <TelegramRoomsPanel />}
      {tab === "digest" && <ChannelDigestPanel />}
      {tab === "major" && <MajorChannelPanel />}
      {tab === "search" && <ChannelSearchPanel />}
      {tab === "stars" && <TelegramStarsPanel />}
    </div>
  );
}
