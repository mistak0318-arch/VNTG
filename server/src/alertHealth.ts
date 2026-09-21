/**
 * **알림 갈래가 지금 어떤 상태인가** — 화면(`/api/settings/alert-health`)과 health.json 이 같이 쓴다.
 *
 * 2026-09-22 에 이 자리를 만든 이유가 있다. 벤티지: "우리 키워드 채널에는 왜 아무것도 안와?"
 * 한 달 동안 아무것도 안 왔고, 나는 코드를 한참 뒤지며 「방 배정이 틀어졌다」는 엉뚱한 가설을 세웠다.
 * 답은 **벤티지가 설정에서 꺼 놓은 것**이었다("내가 설정에서 키워드 부분을 꺼놧엇네").
 *
 * 즉 **「꺼 놨다」와 「고장났다」가 밖에서 똑같이 보였다.** 그게 진짜 결함이다 — 9/21 에 `거래일`·
 * `항해일지` 칸을 붙인 것과 같은 종류다. 갈래마다 **켜짐 · 전용 방 있나 · 마지막 발송**을 한 줄로
 * 내보내면, 다음엔 health.json 한 번으로 갈린다.
 *
 * 싣는 것은 **상태뿐**이다 — 방 이름·chat_id·메시지 내용은 안 싣는다.
 */

export interface AlertSender {
  key: string;
  label: string;
  /** 설정에서 켜져 있나. 끄는 스위치가 없는 갈래는 늘 true, 못 읽으면 null */
  enabled: boolean | null;
  /** 전용 방이 있나 (기본 방으로 떨어지고 있지 않나) */
  room: boolean;
  /** 마지막으로 보낸 시각 (발신 아카이브 기준) */
  lastSent: string | null;
  /** 텔레그램 리더 세션이 있어야 도는 갈래인가 */
  needsReader?: boolean;
  /** 지금이 그 갈래의 시간창 안인가 (창이 있는 갈래만) */
  inWindow?: boolean | null;
}

export interface AlertHealth {
  readerConfigured: boolean;
  botConfigured: boolean;
  senders: AlertSender[];
}

export async function alertHealth(): Promise<AlertHealth> {
  const [{ getAlertConfig }, { getChannelConfig, withinWindow }, keyword, disclosure, rooms, tg, reader] = await Promise.all([
    import("./alertRules.js"),
    import("./channelConfig.js"),
    import("./keywordAlert.js"),
    import("./disclosureAlert.js"),
    import("./telegramArchive.js"),
    import("./telegram.js"),
    import("./telegramReader.js"),
  ]);
  const [alertCfg, chCfg, kwCfg, dcCfg, roomList] = await Promise.all([
    getAlertConfig().catch(() => null),
    getChannelConfig().catch(() => null),
    keyword.getConfig().catch(() => null),
    disclosure.getConfig().catch(() => null),
    rooms.roomsSummary().catch(() => []),
  ]);
  const lastOf = (ch: string): string | null => roomList.find((r: { channel: string }) => r.channel === ch)?.lastAt ?? null;
  const dedicated = (ch: string) => tg.hasDedicatedChannel(ch as never);

  return {
    readerConfigured: reader.isReaderConfigured(),
    botConfigured: tg.isTelegramConfigured(),
    senders: [
      { key: "signal", label: "관심종목 시그널", enabled: alertCfg?.enabled ?? null, room: dedicated("signal"), lastSent: lastOf("signal") },
      { key: "keyword", label: "키워드 알림", enabled: kwCfg?.enabled ?? null, needsReader: true, room: dedicated("keyword"), lastSent: lastOf("keyword") },
      { key: "disclosure", label: "공시 알림", enabled: dcCfg?.enabled ?? null, room: dedicated("disclosure"), lastSent: lastOf("disclosure") },
      {
        key: "channel",
        label: "채널 선별 자동발송",
        enabled: chCfg?.pickAuto?.enabled ?? null,
        needsReader: true,
        inWindow: chCfg?.pickAuto ? withinWindow(chCfg.pickAuto) : null,
        room: dedicated("channel"),
        lastSent: lastOf("channel"),
      },
      /* 스케줄러 고정(15:45) — 끄는 스위치가 없다 */
      { key: "super", label: "슈퍼신호등", enabled: true, room: dedicated("super"), lastSent: lastOf("super") },
      /* 30분 주기 고정. 기준선 3일 뒤부터 발송 */
      { key: "buzz", label: "버즈 레이더", enabled: true, needsReader: true, room: dedicated("buzz"), lastSent: lastOf("buzz") },
      { key: "order", label: "주문·체결", enabled: (process.env.ORDERS_ENABLED ?? "").trim() === "1", room: dedicated("order"), lastSent: lastOf("order") },
      /* 판별 on/off 는 리포트 일정에서 */
      { key: "report", label: "데일리 리포트", enabled: true, room: dedicated("report"), lastSent: lastOf("report") },
      /* 일정·이벤트 — 하루 일곱 번 (2026-09-22) */
      { key: "calendar", label: "일정·이벤트", enabled: null, room: dedicated("calendar"), lastSent: lastOf("calendar") },
    ],
  };
}

/**
 * health.json 한 칸 — 갈래마다 **한 줄**로 줄인다.
 *
 * `키워드 꺼짐 · 전용방 · 마지막 08-26 15:12` 처럼 읽힌다. 한 달 동안 못 봤던 것이 바로 이 줄이다.
 */
export async function alertHealthLines(): Promise<Record<string, unknown>> {
  try {
    const h = await alertHealth();
    const lines = h.senders.map((s) => {
      const on = s.enabled === null ? "?" : s.enabled ? "켜짐" : "**꺼짐**";
      const room = s.room ? "전용방" : "기본방";
      const last = s.lastSent ? s.lastSent.slice(5, 16).replace("T", " ") : "보낸 적 없음";
      const reader = s.needsReader && !h.readerConfigured ? " · 리더세션 없음" : "";
      const win = s.inWindow === false ? " · 시간창 밖" : "";
      return `${s.label}: ${on} · ${room} · 마지막 ${last}${reader}${win}`;
    });
    return { 봇: h.botConfigured ? "설정됨" : "**키 없음**", 리더세션: h.readerConfigured ? "있음" : "없음", 갈래: lines };
  } catch (e) {
    return { 오류: e instanceof Error ? e.message : String(e) };
  }
}
