import { recordApiCall } from "./apiUsage.js";

const PROD_URL = "https://api.kiwoom.com";
const MOCK_URL = "https://mockapi.kiwoom.com";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseExpiresDt(s: string): number {
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(4, 6)) - 1;
  const d = Number(s.slice(6, 8));
  const h = Number(s.slice(8, 10));
  const mi = Number(s.slice(10, 12));
  const se = Number(s.slice(12, 14));
  return new Date(y, mo, d, h, mi, se).getTime();
}

export class KiwoomApiError extends Error {
  constructor(
    public readonly returnCode: number,
    message: string,
    public readonly raw: unknown,
  ) {
    super(message);
    this.name = "KiwoomApiError";
  }
}

interface TokenState {
  token: string;
  expiresAt: number; // epoch ms
}

/**
 * 통합(_AL)을 자동 부착할 TR — **실측했거나 같은 계열로 확인된 것만.**
 * (하이닉스로 실측: ka10059/60 수급 = 키움 앱 일치 · ka10014 공매도 비중 2.79% 일치 ·
 *  ka10015 통합 거래량 6,738,900 일치)
 *
 * ## 어디는 통합이고 어디는 아닌가 (2026-08-26 재검토 — 「구분할 곳은 구분,
 * 통합할 곳은 통합」)
 *
 *   통합(여기)   **표시·현황** — 수급·공매도·거래원·체결·시세표성·프로그램 등.
 *                키움 앱(통합 화면)과 같은 숫자가 나와야 하는 자리
 *   noAl 예외    **거래소를 구분해 보여주는 곳** — /exchanges(KRX·NXT·통합 셋),
 *                호가창의 KRX 기준정보. bare = KRX 라는 의도를 래퍼가 덮으면 안 된다
 *   목록에 없음  **차트(ka10080~83)** — 화면에 KRX/NXT/통합 셀렉터가 있어 접미를
 *                화면이 정하고(기본 통합), 신고가·백테스트·종가배팅·추적 같은
 *                **분석·채점**은 bare(KRX) 그대로 둔다. 종가·시초라는 개념이
 *                KRX 마감(15:30) 기준이고, 쌓아 온 채점 이력과도 이어져야 한다
 *   ka10004 없음 통합 호가란 게 없다 — orderBook 이 KRX→NXT 폴백으로 처리
 */
const AL_TRS = new Set([
  "ka10001", // 기본정보(현재가·등락률·거래량)
  "ka10002", // 거래원
  "ka10003", // 체결(체결강도)
  "ka10007", // 시세표성
  "ka10015", // 일별 거래상세
  "ka10040", // 당일 주요 거래원
  "ka10046", // 체결강도 시간별
  "ka10047", // 체결강도 일별
  "ka10059", // 일별 투자자
  "ka10060", // 투자자 차트
  "ka10095", // 관심종목 시세 (여러 코드 "|" — 각 코드는 호출부가 _AL 처리)
  "ka90013", // 프로그램
  "ka00196", // 체결금액대별
  "ka10014", // 공매도
]);

export class KiwoomClient {
  private readonly baseUrl: string;
  private readonly appKey: string;
  private readonly appSecret: string;
  private tokenState: TokenState | null = null;
  private tokenPromise: Promise<string> | null = null;

  constructor(opts: { appKey: string; appSecret: string; isMock: boolean }) {
    this.appKey = opts.appKey;
    this.appSecret = opts.appSecret;
    this.baseUrl = opts.isMock ? MOCK_URL : PROD_URL;
  }

  /**
   * 웹소켓이 쓸 토큰.
   *
   * ⚠️ **반드시 이걸 통해서 가져가야 한다.** 키움은 앱키 하나에 토큰 하나만 살려 두므로,
   * 웹소켓이 따로 발급받으면 **여기 REST 가 통째로 죽는다**(8005). 같은 캐시를 쓴다.
   */
  async accessToken(): Promise<string> {
    return this.getToken();
  }

  /** 접근토큰발급 (au10001) — 캐시된 토큰이 유효하면 재사용 */
  private async getToken(): Promise<string> {
    if (this.tokenState && this.tokenState.expiresAt > Date.now() + 30_000) {
      return this.tokenState.token;
    }
    if (!this.tokenPromise) {
      this.tokenPromise = this.issueToken().finally(() => {
        this.tokenPromise = null;
      });
    }
    return this.tokenPromise;
  }

  private async issueToken(): Promise<string> {
    const res = await fetch(`${this.baseUrl}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=UTF-8" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: this.appKey,
        secretkey: this.appSecret,
      }),
    });
    if (!res.ok) {
      throw new Error(`토큰 발급 실패: HTTP ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    const token = data.token as string | undefined;
    if (!token) {
      throw new Error(`토큰 발급 응답에 토큰이 없습니다: ${JSON.stringify(data)}`);
    }
    // 응답의 expires_dt는 "YYYYMMDDHHMMSS" 형식의 만료 일시 (로컬 시간 기준)
    const expiresDt = data.expires_dt as string | undefined;
    const expiresAt = expiresDt ? parseExpiresDt(expiresDt) : Date.now() + 23 * 3600 * 1000;
    this.tokenState = { token, expiresAt };
    return token;
  }

  /**
   * 키움 REST API POST 호출 공통 래퍼.
   * resourceUrl 예: /api/dostk/acnt, api-id 예: kt00018
   *
   * ## 통합(_AL) 자동 부착 (2026-08-26 — 「모든 로직은 모든 시장을 반영해야 한다」)
   *
   * 접미 없는 종목코드는 **KRX 단독**이다. 시장은 KRX 만으로 돌지 않는데(NXT 프리·
   * 애프터·병행) 호출처 수십 곳이 전부 bare 코드를 보내고 있었다 — 수급·공매도·
   * 거래원·차트·신호등·백테스트가 죄다 반쪽 시장을 봤다.
   *
   * 그래서 여기 **한 곳에서**: AL_TRS 목록의 TR 에 6자리 bare 코드가 오면 `_AL` 을
   * 붙인다. 명시적 `_NX`/`_AL` 은 건드리지 않는다. 차트 4개 라우트는 화면에
   * KRX/NXT/통합 셀렉터가 있어 `noAl` 로 빠진다 — 사용자가 고른 시장을 서버가
   * 덮어쓰면 안 된다.
   */
  async request<T = Record<string, unknown>>(
    resourceUrl: string,
    apiId: string,
    body: Record<string, unknown> = {},
    opts: { contYn?: string; nextKey?: string; noAl?: boolean } = {},
  ): Promise<{ data: T; contYn: string; nextKey: string }> {
    if (!opts.noAl && AL_TRS.has(apiId) && typeof body.stk_cd === "string" && /^\d{6}$/.test(body.stk_cd)) {
      body = { ...body, stk_cd: `${body.stk_cd}_AL` };
    }
    let token = await this.getToken();
    const maxRetries = 6;
    /*
     * 토큰을 다시 받아 본 횟수.
     *
     * **키움은 앱키 하나에 토큰 하나만 유효하다.** 어딘가에서 같은 앱키로 토큰을 새로 받으면
     * 이쪽이 들고 있던 토큰이 소리 없이 죽는다 — 그때 `8005 Token이 유효하지 않습니다` 가 온다.
     * 예전엔 이걸 다른 오류와 똑같이 곧바로 던졌다. 그러면 **토큰이 자연 만료될 때까지
     * 모든 호출이 실패한다**(최대 하루). 서버를 다시 켜야만 풀렸다.
     *
     * 한 번만 다시 받아 본다. 두 번 이상 하면 다른 쪽과 서로 토큰을 뺏는 핑퐁이 된다 —
     * 그건 코드로 풀 문제가 아니라 앱키를 나눠 쓰는 것 자체가 문제다.
     */
    let reissued = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetch(`${this.baseUrl}${resourceUrl}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
          "api-id": apiId,
          "cont-yn": opts.contYn ?? "N",
          "next-key": opts.nextKey ?? "",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      // HTTP 429: "허용된 요청 개수를 초과하였습니다" - 잠시 대기 후 재시도
      if (res.status === 429) {
        void recordApiCall("kiwoom", apiId, "rateLimited");
        if (attempt < maxRetries) {
          await sleep(400 * (attempt + 1));
          continue;
        }
      }

      if (!res.ok) {
        const text = await res.text();
        void recordApiCall("kiwoom", apiId, "failed", undefined, `HTTP ${res.status}`);
        throw new Error(`키움 API 호출 실패 (${apiId}): HTTP ${res.status} ${text}`);
      }

      const data = (await res.json()) as Record<string, unknown>;
      const returnCode = typeof data.return_code === "number" ? data.return_code : 0;

      // return_code 5: 레이트리밋 초과 (문서상 HTTP 200으로도 내려올 수 있음)
      if (returnCode === 5) {
        void recordApiCall("kiwoom", apiId, "rateLimited");
        if (attempt < maxRetries) {
          await sleep(400 * (attempt + 1));
          continue;
        }
      }
      /*
       * 토큰이 죽었다 — 버리고 새로 받아 한 번 더 해 본다.
       *
       * ⚠️ **`return_code` 는 8005 가 아니다.** 실제 응답은 이렇게 온다 —
       *   `{"return_code":3,"return_msg":"인증에 실패했습니다[8005:Token이 유효하지 않습니다]"}`
       * 8005 는 **메시지 안의 문자열**이다. 예전엔 `returnCode === 8005` 를 봤는데
       * 그 조건은 **영원히 거짓**이라 재발급이 한 번도 안 돌았다 — 토큰이 죽으면
       * 서버를 다시 켤 때까지 모든 호출이 실패했다. 그게 「가끔 그럴 때 있다」의 정체다.
       */
      const tokenDead = returnCode === 8005 || /8005/.test(String(data.return_msg ?? ""));
      if (tokenDead && reissued === 0) {
        reissued += 1;
        void recordApiCall("kiwoom", apiId, "failed", undefined, "8005 토큰 무효 — 재발급");
        console.error(
          "[kiwoom] 토큰이 무효가 됐습니다(8005). 다시 받습니다. " +
            "같은 앱키로 다른 곳에서 토큰을 받으면 이쪽이 죽습니다 — 개발PC와 미니PC가 같은 키를 쓰고 있지 않은지 확인하세요.",
        );
        this.tokenState = null;
        token = await this.getToken();
        continue;
      }

      if (returnCode !== 0) {
        void recordApiCall("kiwoom", apiId, "failed", undefined, `${returnCode} ${data.return_msg ?? ""}`);
        throw new KiwoomApiError(returnCode, String(data.return_msg ?? "알 수 없는 오류"), data);
      }

      void recordApiCall("kiwoom", apiId, "ok");
      return {
        data: data as T,
        contYn: (res.headers.get("cont-yn") ?? (data.cont_yn as string) ?? "N") as string,
        nextKey: (res.headers.get("next-key") ?? (data.next_key as string) ?? "") as string,
      };
    }

    throw new Error(`키움 API 호출 실패 (${apiId}): 재시도 횟수를 초과했습니다 (레이트리밋)`);
  }
}

export function createKiwoomClientFromEnv(): KiwoomClient {
  const appKey = process.env.KIWOOM_APP_KEY;
  const appSecret = process.env.KIWOOM_APP_SECRET;
  if (!appKey || !appSecret) {
    throw new Error(
      "KIWOOM_APP_KEY / KIWOOM_APP_SECRET 환경변수가 설정되지 않았습니다. server/.env 파일을 확인하세요.",
    );
  }
  const isMock = process.env.KIWOOM_IS_MOCK === "true";
  return new KiwoomClient({ appKey, appSecret, isMock });
}
