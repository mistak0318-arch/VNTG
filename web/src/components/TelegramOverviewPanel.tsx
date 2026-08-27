import { useEffect, useState } from "react";
import {
  api,
  type AlertHealth,
  type TelegramChannelStatus,
  type TelegramRoomsData,
  type TelegramRoomStore,
} from "../api";

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
    icon: "🌟",
    name: "슈퍼신호등",
    what: "편입·이탈(15:45) + 슈퍼 종목의 시그널·공시·키워드 알림이 이 방으로 모임",
    channel: "super",
    where: "전용 방(.env TELEGRAM_CHAT_ID_SUPER)이 있을 때만 — 없으면 각자 원래 방으로",
  },
  {
    icon: "🌋",
    name: "버즈 레이더",
    what: "30분 간격 판정 — 채널 언급이 평소의 몇 배로 커진 주제(기준선 3일 후 발송)",
    channel: "buzz",
    where: "전용 방(.env TELEGRAM_CHAT_ID_SUPERSIGNAL) — 장전 브리핑룸 카드에서 전체 확인",
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

  /* 왜 조용한가 (2026-08-27) — 켜짐·마지막 발송을 갈래마다 */
  const [health, setHealth] = useState<AlertHealth | null>(null);

  useEffect(() => {
    api
      .alertConfig()
      .then((r) => setChannels(r.channels))
      .catch((e) => setError(e instanceof Error ? e.message : "불러오기 실패"));
    void api
      .alertHealth()
      .then(setHealth)
      .catch(() => undefined);
  }, []);

  const healthOf = (key: string) => health?.senders.find((s) => s.key === key);

  /** 마지막 발송 — 언제 왔는지가 「돌고 있나」의 답이다 */
  function lastLabel(iso: string | null | undefined): string {
    if (!iso) return "기록 없음";
    const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
    if (m < 60) return `${m}분 전`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}시간 전`;
    return `${Math.floor(h / 24)}일 전`;
  }

  const roomOf = (ch: TelegramChannelStatus["channel"]) =>
    channels.find((c) => c.channel === ch);

  /*
   * 같은 chat_id 를 쓰는 채널이 몇 개인지 — 「전용방」이라 적혀 있어도 실제로는
   * 값이 같아 한 방에 섞여 들어올 수 있다. 그건 여기서만 보인다.
   * log 갈래는 뺀다 — 보내는 코드가 없어서(예비) 같은 방이어도 섞일 게 없다.
   * 실제로 슈퍼신호등이 옛 로그 방을 재활용한다 (2026-08-26).
   */
  const idCount = new Map<string, number>();
  for (const c of channels) {
    if (c.channel === "log") continue;
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
              {/* 조용한 이유를 가르는 두 칸 (2026-08-27) */}
              <th title="꺼져 있으면 주기가 와도 아무 일도 안 일어납니다">상태</th>
              <th title="마지막으로 이 갈래가 실제로 보낸 시각">마지막 발송</th>
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
                {(() => {
                  const h = healthOf(s.channel === "signal" && s.name !== "관심종목 시그널" ? "signal" : s.channel);
                  const off = h?.enabled === false;
                  const noReader = h?.needsReader && health && !health.readerConfigured;
                  return (
                    <>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {h === undefined ? (
                          <span className="pt-n">-</span>
                        ) : off ? (
                          <span className="key-missing">꺼짐</span>
                        ) : noReader ? (
                          <span className="key-missing">세션 없음</span>
                        ) : (
                          <span className="key-ok">켜짐</span>
                        )}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }} className="pt-n">
                        {lastLabel(h?.lastSent)}
                      </td>
                    </>
                  );
                })()}
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
        기본 배정은 서버 <b>server/.env</b> 의 <code>TELEGRAM_CHAT_ID_*</code> 키가 정합니다 —
        비워 두면 그 갈래는 기본 방(<code>TELEGRAM_CHAT_ID</code>)으로 갑니다. 방 만들기 순서는{" "}
        <b>docs/텔레그램_방_구성.md</b>. 아래 「방 배정 바꾸기」로 .env 를 안 고치고도(재시작 없이)
        갈래별 방을 옮길 수 있습니다.
      </div>

      <RoomAssignEditor />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 방 배정 바꾸기 (2026-08-26) — .env 를 안 고치고 갈래별 보내는 방 변경   */
/* ------------------------------------------------------------------ */

const ASSIGN_LABEL: Record<string, string> = {
  report: "📰 리포트",
  signal: "🔔 시그널 (VI·손절 포함)",
  buzz: "🌋 버즈 레이더",
  super: "🌟 슈퍼신호등",
  channel: "📡 채널 수집",
  disclosure: "📄 공시",
  keyword: "🔍 키워드",
  log: "🪵 로그(예비)",
};
/** 화면에 보여줄 순서 — 서버 enum 순서가 아니라 쓰는 빈도 순 */
const ASSIGN_ORDER = ["report", "signal", "buzz", "super", "channel", "disclosure", "keyword", "log"];

function RoomAssignEditor() {
  const [data, setData] = useState<TelegramRoomsData | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [newId, setNewId] = useState("");

  useEffect(() => {
    api
      .telegramRooms()
      .then(setData)
      .catch((e: Error) => setMsg(e.message));
  }, []);

  if (!data) return null;

  const rooms: { label: string; chatId: string }[] = [
    ...data.envRooms.map((r) => ({ label: `${r.label} (.env)`, chatId: r.chatId })),
    ...data.store.custom.map((c) => ({ label: `${c.name || c.chatId} (직접 등록)`, chatId: c.chatId })),
  ];

  async function save(next: TelegramRoomStore) {
    setBusy(true);
    try {
      const r = await api.telegramRoomsSave(next);
      setData((prev) => (prev ? { ...prev, store: r.store, channels: r.channels } : prev));
      setMsg("저장했습니다 — 다음 발송부터 이 방으로 갑니다 (재시작 불필요).");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setBusy(false);
    }
  }

  async function test(ch: string) {
    setBusy(true);
    try {
      const r = await api.telegramRoomTest(ch);
      setMsg(r.ok ? `「${ASSIGN_LABEL[ch] ?? ch}」 방으로 시험 메시지를 보냈습니다 — 텔레그램을 확인하세요.` : r.error ?? "발송 실패");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "발송 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tro-edit">
      <h3>방 배정 바꾸기</h3>
      <p className="page-note">
        갈래마다 보낼 방을 고릅니다 — <b>기본(.env)</b>이면 환경변수 그대로, 방을 고르면
        그쪽이 우선합니다(서버 재시작 없이 즉시). 「시험」을 누르면 그 갈래로 한 통 보내
        배정이 맞는지 바로 확인할 수 있습니다.
      </p>
      <div className="tro-rows">
        {ASSIGN_ORDER.map((ch) => {
          const st = data.channels.find((c) => c.channel === ch);
          return (
            <div className="tro-row" key={ch}>
              <span className="tro-name">{ASSIGN_LABEL[ch] ?? ch}</span>
              <select
                className="group-select"
                value={data.store.assign[ch] ?? ""}
                disabled={busy}
                onChange={(e) => {
                  const assign = { ...data.store.assign };
                  if (e.target.value) assign[ch] = e.target.value;
                  else delete assign[ch];
                  void save({ ...data.store, assign });
                }}
              >
                <option value="">기본(.env{st?.envChatId ? "" : " 없음 → 기본 방"})</option>
                {rooms.map((r) => (
                  <option key={r.chatId} value={r.chatId}>
                    {r.label}
                  </option>
                ))}
              </select>
              <button className="filter-btn" onClick={() => void test(ch)} disabled={busy}>
                시험
              </button>
              {st?.overridden && <span className="pt-n">재배정됨</span>}
            </div>
          );
        })}
      </div>

      <div className="tro-add">
        <input
          className="search-input"
          placeholder="방 이름 (예: 임시 테스트방)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <input
          className="search-input"
          placeholder="chat_id (예: -1001234567890)"
          value={newId}
          onChange={(e) => setNewId(e.target.value)}
        />
        <button
          className="filter-btn"
          disabled={busy || !newId.trim()}
          onClick={() => {
            void save({
              ...data.store,
              custom: [...data.store.custom, { name: newName.trim(), chatId: newId.trim() }],
            });
            setNewName("");
            setNewId("");
          }}
        >
          방 등록
        </button>
        {data.store.custom.length > 0 && (
          <span className="pt-n">
            등록된 방:{" "}
            {data.store.custom.map((c) => (
              <button
                key={c.chatId}
                className="tro-del"
                title="지우기 (배정에서 쓰는 중이면 그 배정도 기본으로 돌아갑니다)"
                onClick={() => {
                  const assign = Object.fromEntries(
                    Object.entries(data.store.assign).filter(([, v]) => v !== c.chatId),
                  );
                  void save({
                    assign,
                    custom: data.store.custom.filter((x) => x.chatId !== c.chatId),
                  });
                }}
              >
                {c.name || c.chatId} ✕
              </button>
            ))}
          </span>
        )}
      </div>
      {msg && <div className="alert-note">{msg}</div>}
    </div>
  );
}
