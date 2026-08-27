import { Router } from "express";
import { getHistory, getTotals, getUsage } from "../apiUsage.js";
import { summarize } from "../summarize.js";
import { getMenuPrefs, saveMenuPrefs } from "../menuPrefs.js";
import { getBoardPrefs, saveBoardPrefs } from "../boardPrefs.js";
import { getUiPrefs, patchUiPrefs } from "../uiPrefs.js";
import { getCardOrder, saveCardOrder } from "../cardOrder.js";
import { getColumnWidths, saveColumnWidths } from "../columnWidths.js";

export function createSettingsRouter(): Router {
  const router = Router();

  router.get("/usage", async (req, res, next) => {
    try {
      const day = typeof req.query.day === "string" ? req.query.day : undefined;
      res.json(await getUsage(day));
    } catch (err) {
      next(err);
    }
  });

  /** 보관 기간 전체의 AI 비용 — 하루치만 보면 "얼마 썼나"에 답을 못 한다 */
  router.get("/usage/totals", async (req, res, next) => {
    try {
      const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 30);
      res.json(await getTotals(days));
    } catch (err) {
      next(err);
    }
  });

  router.get("/usage/history", async (req, res, next) => {
    try {
      const days = Math.min(Number(req.query.days) || 14, 30);
      res.json({ history: await getHistory(days) });
    } catch (err) {
      next(err);
    }
  });

  /** 어떤 키가 설정되어 있는지만 알려준다 (값은 절대 내보내지 않음) */
  /**
   * 알림 점검 (2026-08-27) — **왜 조용한가.**
   *
   * 알림이 안 오는 이유는 다섯 가지인데(꺼짐·시간대 아님·세션 없음·방 없음·보낼 게 없음)
   * 전부 「아무것도 안 옴」으로 똑같이 보인다. 실제로 「버즈가 안 온다」·「슈퍼신호등이
   * 안 온다」가 나왔고, 그게 고장인지 조용한 것인지 가릴 방법이 없었다.
   *
   * 갈래마다 **켜짐·시간창·방 배정·마지막 발송**을 한 줄로 준다. 마지막 발송은
   * 발신 아카이브(받은 방)에서 읽는다 — 보낸 것이 거기 그대로 쌓이므로 가장 정확하다.
   */
  router.get("/alert-health", async (_req, res, next) => {
    try {
      const [{ getAlertConfig }, { getChannelConfig, withinWindow }, keyword, disclosure, rooms, tg, reader] =
        await Promise.all([
          import("../alertRules.js"),
          import("../channelConfig.js"),
          import("../keywordAlert.js"),
          import("../disclosureAlert.js"),
          import("../telegramArchive.js"),
          import("../telegram.js"),
          import("../telegramReader.js"),
        ]);
      const [alertCfg, chCfg, kwCfg, dcCfg, roomList] = await Promise.all([
        getAlertConfig().catch(() => null),
        getChannelConfig().catch(() => null),
        keyword.getConfig().catch(() => null),
        disclosure.getConfig().catch(() => null),
        rooms.roomsSummary().catch(() => []),
      ]);
      const lastOf = (ch: string): string | null =>
        roomList.find((r: { channel: string }) => r.channel === ch)?.lastAt ?? null;
      const dedicated = (ch: string) => tg.hasDedicatedChannel(ch as never);

      res.json({
        readerConfigured: reader.isReaderConfigured(),
        botConfigured: tg.isTelegramConfigured(),
        senders: [
          {
            key: "signal",
            label: "관심종목 시그널",
            enabled: alertCfg?.enabled ?? null,
            room: dedicated("signal"),
            lastSent: lastOf("signal"),
          },
          {
            key: "keyword",
            label: "키워드 알림",
            enabled: kwCfg?.enabled ?? null,
            needsReader: true,
            room: dedicated("keyword"),
            lastSent: lastOf("keyword"),
          },
          {
            key: "disclosure",
            label: "공시 알림",
            enabled: dcCfg?.enabled ?? null,
            room: dedicated("disclosure"),
            lastSent: lastOf("disclosure"),
          },
          {
            key: "channel",
            label: "채널 선별 자동발송",
            enabled: chCfg?.pickAuto?.enabled ?? null,
            needsReader: true,
            inWindow: chCfg?.pickAuto ? withinWindow(chCfg.pickAuto) : null,
            room: dedicated("channel"),
            lastSent: lastOf("channel"),
          },
          {
            key: "super",
            label: "슈퍼신호등",
            enabled: true, // 스케줄러 고정(15:45) — 끄는 스위치가 없다
            room: dedicated("super"),
            lastSent: lastOf("super"),
          },
          {
            key: "buzz",
            label: "버즈 레이더",
            enabled: true, // 30분 주기 고정. 기준선 3일 뒤부터 발송
            needsReader: true,
            room: dedicated("buzz"),
            lastSent: lastOf("buzz"),
          },
          {
            key: "report",
            label: "데일리 리포트",
            enabled: true, // 판별 on/off 는 리포트 일정에서
            room: dedicated("report"),
            lastSent: lastOf("report"),
          },
        ],
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/keys", (_req, res) => {
    res.json({
      keys: [
        { name: "KIWOOM_APP_KEY", configured: Boolean(process.env.KIWOOM_APP_KEY) },
        { name: "KIWOOM_APP_SECRET", configured: Boolean(process.env.KIWOOM_APP_SECRET) },
        { name: "DART_API_KEY", configured: Boolean(process.env.DART_API_KEY) },
        { name: "NAVER_CLIENT_ID", configured: Boolean(process.env.NAVER_CLIENT_ID) },
        { name: "NAVER_CLIENT_SECRET", configured: Boolean(process.env.NAVER_CLIENT_SECRET) },
        { name: "ANTHROPIC_API_KEY", configured: Boolean(process.env.ANTHROPIC_API_KEY) },
        { name: "TELEGRAM_BOT_TOKEN", configured: Boolean(process.env.TELEGRAM_BOT_TOKEN) },
        { name: "TELEGRAM_CHAT_ID", configured: Boolean(process.env.TELEGRAM_CHAT_ID) },
        { name: "NAVER_MAIL_USER", configured: Boolean(process.env.NAVER_MAIL_USER) },
        { name: "NAVER_MAIL_PASS", configured: Boolean(process.env.NAVER_MAIL_PASS) },
      ],
      isMock: process.env.KIWOOM_IS_MOCK === "true",
    });
  });

  /** Claude 연결 테스트 — 실제 호출이라 토큰 사용량에도 반영된다 */
  router.post("/claude/test", async (_req, res, next) => {
    try {
      const r = await summarize("'연결 성공'이라고만 답해줘.", 50);
      res.json({ ok: r.text !== null, ...r });
    } catch (err) {
      next(err);
    }
  });

  /*
   * 사이드바 메뉴 설정 — 서버에 둔다.
   * 미니PC 에서 정한 즐겨찾기를 폰에서도 그대로 봐야 한다.
   */
  router.get("/menu", async (_req, res, next) => {
    try {
      res.json(await getMenuPrefs());
    } catch (err) {
      next(err);
    }
  });

  router.put("/menu", async (req, res, next) => {
    try {
      res.json(await saveMenuPrefs(req.body));
    } catch (err) {
      next(err);
    }
  });

  /*
   * 화면 설정 **전부** — 키 하나에 값 하나.
   *
   * 설정마다 저장소를 따로 만들다 보니 급할 때는 그냥 localStorage 에 넣게 됐고
   * 그렇게 열네 개가 이 기기에만 쌓였다. 새 설정을 넣는 일이 **로컬에 넣는 것만큼
   * 쉬워야** 전역이 기본이 된다.
   *
   * PUT 은 **합친다**(덮어쓰지 않는다). 창이 여럿이면 각자 자기가 바꾼 것만 보내는데
   * 통째로 갈아치우면 다른 창이 방금 바꾼 설정이 사라진다.
   */
  router.get("/ui", async (_req, res, next) => {
    try {
      res.json(await getUiPrefs());
    } catch (err) {
      next(err);
    }
  });

  router.put("/ui", async (req, res, next) => {
    try {
      res.json({ values: await patchUiPrefs(req.body) });
    } catch (err) {
      next(err);
    }
  });

  /*
   * 보드 화면 구성 — **창끼리 덮어쓰던 것을 여기로 옮겼다.**
   * localStorage 는 창끼리 공유돼서, 창 A 가 K1 을 불러오면 창 B 의 K2 를 지웠다.
   */
  router.get("/board", async (_req, res, next) => {
    try {
      res.json(await getBoardPrefs());
    } catch (err) {
      next(err);
    }
  });

  router.put("/board", async (req, res, next) => {
    try {
      res.json(await saveBoardPrefs(req.body));
    } catch (err) {
      next(err);
    }
  });

  /* 화면 카드 배치 — 즐겨찾기와 같은 이유로 서버에 둔다 */
  router.get("/cards", async (_req, res, next) => {
    try {
      res.json(await getCardOrder());
    } catch (err) {
      next(err);
    }
  });

  router.put("/cards", async (req, res, next) => {
    try {
      res.json(await saveCardOrder(req.body));
    } catch (err) {
      next(err);
    }
  });

  /*
   * 표 칸 너비 — 카드 배치와 **같은 층**이다.
   * 「이 표에서 무엇을 넓게 보나」는 그 사람이 표를 읽는 방식이라 기기가 바뀌어도 따라와야 한다.
   */
  router.get("/columns", async (_req, res, next) => {
    try {
      res.json(await getColumnWidths());
    } catch (err) {
      next(err);
    }
  });

  router.put("/columns", async (req, res, next) => {
    try {
      res.json(await saveColumnWidths(req.body));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
