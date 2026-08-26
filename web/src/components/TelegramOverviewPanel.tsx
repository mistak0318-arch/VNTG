import { useEffect, useState } from "react";
import { api, type TelegramChannelStatus } from "../api";

/**
 * 텔레그램 발송 한눈에 (2026-08-26).
 *
 * 텔레그램으로 나가는 게 여덟 갈래인데, 설정이 세 군데(설정>발행·알림, 텔레그램 동향,
 * .env)에 흩어져 있어 **뭐가 어디로 언제 가는지**를 한 자리에서 볼 곳이 없었다.
 * 이 표가 그 자리다 — 발송 기능 전체와 방 배정 상태를 보여주고, 설정이 어디 있는지 안내한다.
 *
 * 행 목록은 서버 발송 코드와 손으로 맞춘다(발송 지점이 늘면 여기도 한 줄 는다).
 * 방 배정(chat_id)은 서버 .env 가 진실이므로 /api/alert/config 의 channels 로 받는다.
 */

interface SenderRow {
  icon: string;
  name: string;
  /** 무엇이 언제 오는지 한 줄 */
  what: string;
  /** telegram.ts 의 채널 키 */
  channel: TelegramChannelStatus["channel"];
  /** 어디서 설정하는지 */
  where: string;
}

const SENDERS: SenderRow[] = [
  {
    icon: "📰",
    name: "데일리 리포트",
    what: "발행 일정대로 하루 3판(조간·장중·석간) — 메일도 같이",
    channel: "report",
    where: "설정 > 발행·알림 > 리포트 발행 일정",
  },
  {
    icon: "🔔",
    name: "관심종목 시그널",
    what: "장중 10분 간격 — 급변·거래량 급증·수급 전환·신고가·정배열",
    channel: "signal",
    where: "설정 > 발행·알림 > 관심종목 시그널",
  },
  {
    icon: "⚡",
    name: "VI · 체결강도",
    what: "장중 1분 간격, 실시간에서 바로(조회 0) — 관심종목만",
    channel: "signal",
    where: "설정 > 발행·알림 > 관심종목 시그널 (같은 규칙 목록)",
  },
  {
    icon: "🛑",
    name: "손절 감시",
    what: "장중 1분 간격 — 복기 노트에 손절선을 적은 보유 종목만",
    channel: "signal",
    where: "복기 노트에 손절선을 적으면 자동으로 감시",
  },
  {
    icon: "📡",
    name: "채널 AI 정리",
    what: "07 / 12 / 18시 — 구독 채널을 AI 가 추려서 정리",
    channel: "channel",
    where: "텔레그램 동향 > AI 관리 · 채널 관리",
  },
  {
    icon: "📌",
    name: "채널 선별 자동발송",
    what: "새 글이 걸리면 건별로(기본 5분 주기, AI 없음·비용 0)",
    channel: "channel",
    where: "텔레그램 동향 > 선별 관리",
  },
  {
    icon: "📄",
    name: "공시 알림",
    what: "켜면 10분 간격(기본 08~19시) — 관심종목·내 테마·주요 공시",
    channel: "disclosure",
    where: "텔레그램 동향 > 공시 알림",
  },
  {
    icon: "🔍",
    name: "키워드 알림",
    what: "켜면 10분 간격(기본 08~20시) — 내 종목·키워드가 채널에 뜨면 바로",
    channel: "keyword",
    where: "텔레그램 동향 > 내 관심 키워드",
  },
];

export function TelegramOverviewPanel() {
  const [channels, setChannels] = useState<TelegramChannelStatus[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .alertConfig()
      .then((r) => setChannels(r.channels))
      .catch((e) => setError(e instanceof Error ? e.message : "불러오기 실패"));
  }, []);

  const roomOf = (ch: TelegramChannelStatus["channel"]) =>
    channels.find((c) => c.channel === ch);

  /*
   * 같은 chat_id 를 쓰는 채널이 몇 개인지 — 「전용방」이라 적혀 있어도 실제로는
   * 값이 같아 한 방에 섞여 들어올 수 있다. 그건 여기서만 보인다.
   */
  const idCount = new Map<string, number>();
  for (const c of channels) {
    if (c.chatId) idCount.set(c.chatId, (idCount.get(c.chatId) ?? 0) + 1);
  }

  function roomLabel(ch: TelegramChannelStatus["channel"]): string {
    const room = roomOf(ch);
    if (!room || !room.chatId) return "미설정";
    if (!room.dedicated) return "기본 방";
    return (idCount.get(room.chatId) ?? 1) > 1 ? "전용 (다른 갈래와 같은 방)" : "전용 방";
  }

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th className="sticky-col">무엇이</th>
              <th>언제 · 어떤 내용</th>
              <th>방</th>
              <th>설정 위치</th>
            </tr>
          </thead>
          <tbody>
            {SENDERS.map((s) => (
              <tr key={`${s.name}`}>
                <td className="sticky-col" style={{ whiteSpace: "nowrap" }}>
                  {s.icon} <b>{s.name}</b>
                </td>
                <td>{s.what}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <span className={roomOf(s.channel)?.dedicated ? "key-ok" : "key-missing"}>
                    {roomLabel(s.channel)}
                  </span>
                </td>
                <td>{s.where}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-note">
        방 배정은 서버 <b>server/.env</b> 의 <code>TELEGRAM_CHAT_ID_리포트/시그널/채널/공시/키워드</code>
        (REPORT · SIGNAL · CHANNEL · DISCLOSURE · KEYWORD) 값이 정합니다 — 비워 두면 그 갈래는
        기본 방(<code>TELEGRAM_CHAT_ID</code>)으로 갑니다. 방을 나누는 순서: ① 텔레그램에서 그룹을
        만들고 ② 봇을 초대한 뒤 ③ 그 그룹의 chat_id 를 .env 에 적고 서버를 재시작합니다.
        자세한 순서는 <b>docs/텔레그램_방_구성.md</b> 에 있습니다.
      </div>
    </div>
  );
}
