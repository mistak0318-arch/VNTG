import type { KiwoomClient } from "./kiwoomClient.js";

/**
 * 키움 실시간시세(웹소켓) — **서버가 하나만 물고 있는다.**
 *
 * ## 왜 서버가 무나
 *
 * 화면이 직접 붙으면 **창을 열 때만 쌓이고**, 창이 여럿이면 연결도 여럿이 된다.
 * 거래원 시간대별이 쓸모없어진 이유가 정확히 그것이다 — 보고 있을 때만 점이 찍히니
 * 장 끝난 뒤엔 같은 값이 여러 줄 남았다. 서버가 하루 종일 물고 쌓아야 시계열이 된다.
 *
 * ## 토큰은 REST 와 **같은 것**을 쓴다
 *
 * 키움은 앱키 하나에 토큰 하나만 살려 둔다. 여기서 따로 발급받으면 REST 쪽이 통째로
 * 죽는다(8005). 그래서 `KiwoomClient.accessToken()` 을 통해서만 가져온다.
 *
 * ## 접속 규약은 **문서에 없다**
 *
 * 받은 문서(344 시트)에는 REG/REMOVE/REAL 만 있고 로그인·PING 규약이 없다.
 * 그래서 **추측하지 않고 서버가 하는 말을 그대로 기록한다** — `onFrame` 으로 들어오는
 * 모든 프레임을 남겨서, 무엇을 요구하는지 눈으로 보고 맞춘다.
 * 아래 `LOGIN` 은 **확인된 규약이 아니라 첫 시도**다. 응답을 보고 고칠 자리.
 *
 * ## 재연결이 기능의 절반이다
 *
 * 하루 종일 물고 있어야 하므로 끊김이 정상 상태다. 끊기면 점점 뜸하게 다시 붙고,
 * 붙으면 **구독을 다시 건다** — 안 그러면 조용히 아무것도 안 오는 상태가 된다.
 *
 * ## ⚠️ 언제든 폴링으로 돌아갈 수 있어야 한다
 *
 * 실시간은 **얹는 것**이지 대체하는 게 아니다. 지켜야 할 세 가지:
 *
 *   1. **화면의 REST 폴링을 걷어내지 않는다.** 실시간은 「지금부터의 변화」만 주므로
 *      처음 열었을 때의 현재 상태는 어차피 REST 가 있어야 한다. 밑그림은 REST,
 *      갱신은 웹소켓.
 *   2. **끌 수 있어야 한다.** `REALTIME_ENABLED=0` 이면 아예 안 붙는다.
 *      미니PC 에서 이상하면 이 한 줄로 어제 상태로 돌아간다.
 *   3. **죽은 걸 죽었다고 말해야 한다.** 폴링은 실패하면 에러가 나지만 웹소켓은
 *      끊긴 걸 모르면 **「시장이 조용하네」로 보인다.** 마지막 수신 시각을 들고 있다가
 *      너무 오래 조용하면 `healthy` 가 거짓이 되고, 그걸 보고 폴링으로 되돌린다.
 */

/** 이만큼 아무것도 안 오면 죽은 것으로 본다 (장중 기준) */
const STALE_MS = 90_000;

const WS_URL = "wss://api.kiwoom.com:10000/api/dostk/websocket";

export interface RealtimeFrame {
  trnm?: string;
  return_code?: number;
  return_msg?: string;
  data?: {
    type?: string;
    name?: string;
    item?: string;
    values?: Record<string, string>;
  }[];
  [k: string]: unknown;
}

type Listener = (f: RealtimeFrame) => void;

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<Listener>();
  /** 구독 중인 것 — 다시 붙었을 때 그대로 되건다 */
  private readonly subs = new Map<string, Set<string>>();
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** 마지막으로 뭐라도 받은 시각 — 「조용한 것」과 「죽은 것」을 가른다 */
  private lastFrameAt = 0;

  /** 최근 프레임 — 무엇이 오는지 눈으로 보려고 남긴다 */
  readonly log: { at: string; dir: "→" | "←"; text: string }[] = [];

  constructor(private readonly kiwoom: KiwoomClient) {}

  onFrame(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private note(dir: "→" | "←", text: string): void {
    this.log.push({ at: new Date().toISOString(), dir, text: text.slice(0, 600) });
    // 오래된 건 버린다 — 진단용이지 저장소가 아니다
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
  }

  /**
   * 한 줄 보낸다.
   *
   * ⚠️ **보내기 전에 열려 있는지 본다.** `ws.send` 는 연결 전이면 예외를 던지는데, 그게
   * 이벤트 콜백 안에서 나면 아무도 못 잡아 **프로세스가 통째로 죽는다.** 실제로 그렇게
   * 서버가 내려갔다(`DOMException: Sent before connected`).
   *
   * `onopen` 안에서 불러도 안전하지 않다 — 그 사이 재연결이 일어나면 `this.ws` 는 이미
   * **다른 소켓**이다. 그래서 보낼 소켓을 받을 수 있게 두고, 콜백은 자기 소켓을 넘긴다.
   *
   * 못 보낸 건 기록만 남긴다. 구독 한 줄이 빠지는 것과 서버가 죽는 것은 무게가 다르다.
   */
  private send(obj: unknown, sock?: WebSocket): void {
    const ws = sock ?? this.ws;
    const text = JSON.stringify(obj);
    this.note("→", text);
    if (!ws || ws.readyState !== 1) {
      this.note("→", "(못 보냄 — 연결이 아직 안 열렸다)");
      return;
    }
    try {
      ws.send(text);
    } catch (e) {
      this.note("→", `(보내기 실패: ${e instanceof Error ? e.message : String(e)})`);
    }
  }

  /** 환경변수로 끌 수 있다 — 이상하면 이 한 줄로 어제 상태가 된다 */
  static get enabled(): boolean {
    return process.env.REALTIME_ENABLED !== "0";
  }

  /**
   * 실시간을 믿어도 되는가.
   *
   * 화면은 이걸 보고 **폴링으로 되돌린다.** 붙어 있어도 오래 조용하면 거짓이다 —
   * 끊긴 걸 모르는 채로 「시장이 조용하네」라고 읽는 게 제일 위험하다.
   */
  get healthy(): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    if (this.lastFrameAt === 0) return false;
    return Date.now() - this.lastFrameAt < STALE_MS;
  }

  get lastSeen(): string | null {
    return this.lastFrameAt ? new Date(this.lastFrameAt).toISOString() : null;
  }

  async connect(): Promise<void> {
    if (!RealtimeClient.enabled) throw new Error("실시간이 꺼져 있습니다 (REALTIME_ENABLED=0)");
    this.closed = false;
    if (this.ws) return;

    const token = await this.kiwoom.accessToken();
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.note("←", "(연결됨)");
      /*
       * 문서에 없는 부분이다. 이 모양이 아니면 서버가 뭐라고든 답할 것이고,
       * 그 답이 `log` 에 남는다 — 그걸 보고 고친다.
       */
      this.send({ trnm: "LOGIN", token }, ws);
    };

    ws.onmessage = (ev: MessageEvent) => {
      const text = typeof ev.data === "string" ? ev.data : String(ev.data);
      this.lastFrameAt = Date.now();
      this.note("←", text);
      let frame: RealtimeFrame;
      try {
        frame = JSON.parse(text) as RealtimeFrame;
      } catch {
        return;
      }

      // 살아 있는지 묻는 프레임은 **그대로 돌려준다**. 안 돌려주면 끊긴다
      if (frame.trnm === "PING") {
        this.send(frame);
        return;
      }

      // 로그인이 끝나면 걸어 둔 구독을 올린다
      if (frame.trnm === "LOGIN" && frame.return_code === 0) this.resubscribe();

      /*
       * ⚠️ **REG 실패를 붙잡아 둔다.**
       *
       * 등록이 거절돼도 소켓은 「연결됨·healthy」다. 그래서 **프레임이 안 오는데
       * 상태창은 멀쩡하다** — 제일 알아채기 어려운 실패다. 실제로 하루 종일
       * `105118`(그룹당 200종목 초과)로 전부 거절된 걸 모르고 있었다.
       *
       * 프레임 로그는 PING 이 10초마다 밀어내서 REG 응답이 금방 사라진다.
       * 그래서 **실패만 따로** 남긴다 — 여기 뭐가 있으면 그게 원인이다.
       */
      if (frame.trnm === "REG" && frame.return_code !== 0) {
        this.regErrors.push({
          at: new Date().toISOString(),
          code: Number(frame.return_code ?? -1),
          msg: String(frame.return_msg ?? ""),
        });
        if (this.regErrors.length > 20) this.regErrors.shift();
        console.log(`실시간: REG 실패 ${frame.return_code} — ${frame.return_msg}`);
      }

      for (const l of this.listeners) l(frame);
    };

    ws.onclose = () => {
      this.note("←", "(끊김)");
      this.ws = null;
      this.scheduleRetry();
    };

    ws.onerror = () => {
      this.note("←", "(오류)");
    };
  }

  /**
   * 다시 붙었을 때 구독을 되건다.
   * 이걸 빠뜨리면 **연결은 살아 있는데 아무것도 안 오는** 상태가 된다 — 제일 알아채기 어렵다.
   */
  private resubscribe(): void {
    /*
     * 걸어 둔 것을 **`pending` 에 다시 넣고 `flush` 에 맡긴다.**
     *
     * ⚠️ 예전엔 여기서 직접 REG 를 한 방에 보냈다. 그러면 **200종목 상한(105118)에
     * 그대로 걸린다** — 아래 `flush` 가 200개씩 그룹을 나누는데 이 길만 그걸 안 거쳤다.
     * 나눠 보내는 규칙은 한 곳에만 있어야 한다.
     */
    for (const [type, items] of this.subs) {
      for (const item of items) {
        const p = this.pending.get(type) ?? new Set<string>();
        p.add(item);
        this.pending.set(type, p);
      }
    }
    this.flush();
  }

  private scheduleRetry(): void {
    if (this.closed || this.timer) return;
    // 점점 뜸하게 — 끊긴 이유가 우리 쪽이 아닐 때 두들기면 더 나빠진다
    const wait = Math.min(2000 * 2 ** this.retry, 60_000);
    this.retry += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, wait);
  }

  /**
   * 구독한다 — **종목을 한꺼번에 넘겨야 한다.**
   *
   * ⚠️ 여기서 크게 데였다. 처음엔 종목 하나에 REG 한 번씩 보냈는데,
   * 50 종목을 걸었더니 **5건만 통과하고 44건이 거절**됐다:
   *
   *     return_code 105110  "해당 TRNM으로 허용된 요청 건수를 초과하였습니다 (TRNM=REG)"
   *
   * 막힌 것은 **종목 수가 아니라 REG 요청 횟수**다. `data[].item` 이 배열인 이유가
   * 그것이었다 — 한 번에 몰아 넣으라는 뜻이다.
   *
   * 그래서 여기서는 **바로 안 보내고 모았다가** 짧은 틈을 두고 한 번에 보낸다.
   * 화면 여러 곳이 각자 종목을 걸어도 요청은 한 번으로 합쳐진다.
   *
   * ## ⚠️ 200종목 상한을 **여기서** 지킨다 (2026-08-25)
   *
   * 스케줄러가 200 을 딱 맞춰 걸어 놨는데, 화면이 종목을 볼 때마다 그 자리에서
   * 구독을 더했다(`/series`·`/latest`). 그래서 종목 세 개만 눌러 봐도 203 이 되고
   * **그때부터 REG 가 전부 거절**된다(105118). 실제로 그랬다 — 200 으로 낮춘 지
   * 한 시간 만에 오류가 11건 쌓였다.
   *
   * 상한을 스케줄러 쪽에서만 지키면 안 된다. **구독이 들어오는 문이 둘**이기 때문이다.
   * 그래서 문을 지키는 자리를 여기 하나로 둔다.
   *
   * 두 갈래로 나눈다:
   *   **고정**(`keep`)  스케줄러가 건 것 — 관심종목·거래대금 상위. **안 뺀다**
   *   **임시**         화면이 지금 보는 종목 — 상한에 닿으면 **오래된 것부터 뺀다**
   *
   * 화면이 보던 종목은 창을 닫으면 안 봐도 되지만 관심종목은 하루 종일 필요하다 —
   * 밀려나면 안 되는 쪽이 정해져 있다.
   */
  private static readonly MAX_ITEMS = 200;

  /**
   * `type:item` → 어느 `grp_no` 에 등록했나 (2026-08-31).
   *
   * REMOVE 는 **그 그룹에만** 보내야 한다. 모르면 전 그룹에 뿌리게 되는데, 그러면
   * REG 와 같은 `105110`(요청 건수 초과)에 걸린다 — 상한을 피하려던 것이 다른
   * 상한을 만든다.
   */
  private readonly groupOf = new Map<string, string>();
  /** 스케줄러가 건 종목 — 밀려나면 안 된다 */
  private readonly keep = new Set<string>();
  /** 화면이 건 종목 — 들어온 순서대로(오래된 것이 앞) */
  private readonly transient: string[] = [];

  /** 지금 걸려 있는 **종목** 수 (타입은 안 센다 — 상한이 종목 기준이다) */
  private codeCount(): number {
    const all = new Set<string>(this.keep);
    for (const c of this.transient) all.add(c);
    return all.size;
  }

  /**
   * 스케줄러가 거는 자리 — **이건 안 밀려난다.**
   * 부르는 쪽이 이미 200 안쪽으로 잘라서 준다.
   */
  subscribeKeep(type: string, item: string): void {
    this.keep.add(item);
    // 고정으로 올라왔으면 임시 목록에서는 뺀다 — 같은 종목을 두 번 셀 이유가 없다
    const i = this.transient.indexOf(item);
    if (i >= 0) this.transient.splice(i, 1);
    this.subscribe(type, item);
  }

  /**
   * 화면이 지금 보는 종목 — **상한에 닿으면 오래된 것을 빼고 넣는다.**
   *
   * 뺄 때 `REMOVE` 를 보내야 서버 쪽 정원도 같이 준다. 안 보내면 우리만 잊고
   * 서버는 그대로 물고 있어서 상한이 안 풀린다.
   */
  subscribeTransient(type: string, item: string): void {
    if (!this.keep.has(item) && !this.transient.includes(item)) {
      while (this.codeCount() >= RealtimeClient.MAX_ITEMS && this.transient.length > 0) {
        const old = this.transient.shift();
        if (!old) break;
        for (const t of [...this.subs.keys()]) {
          if (this.subs.get(t)?.has(old)) this.unsubscribe(t, old);
        }
      }
      /* 고정만으로 이미 꽉 찼으면 화면 종목은 포기한다 — 관심종목을 밀어낼 수는 없다 */
      if (this.codeCount() >= RealtimeClient.MAX_ITEMS) return;
      this.transient.push(item);
    }
    this.subscribe(type, item);
  }

  subscribe(type: string, item: string): void {
    let set = this.subs.get(type);
    if (!set) {
      set = new Set();
      this.subs.set(type, set);
    }
    if (set.has(item)) return;
    set.add(item);
    this.queue(type, item);
  }

  /** 보낼 것을 모아 둔다 (TR → 종목들) */
  private readonly pending = new Map<string, Set<string>>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private queue(type: string, item: string): void {
    let p = this.pending.get(type);
    if (!p) {
      p = new Set();
      this.pending.set(type, p);
    }
    p.add(item);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 300);
  }

  /**
   * ## 상한 셋을 동시에 지켜야 한다 (2026-08-25 실측)
   *
   * 서버가 계속 말하고 있었는데 우리가 안 보고 있었다:
   *
   *     105118  등록 종목이 **그룹번호**에 등록할 수 있는 허용 개수(200)를 초과
   *     105115  등록 **종목이** 허용 개수(200)를 초과      ← 연결 전체
   *     105110  해당 TRNM 으로 허용된 **요청 건수**를 초과   ← 나눠 보내도 걸린다
   *
   * 즉 **한 연결에 200종목**이고, 그룹을 나눠도 총합은 그대로다. 그렇다고 잘게 나눠
   * 여러 번 보내면 이번엔 요청 횟수에 걸린다. **한 번에, 200 안쪽으로** 보내야 한다.
   *
   * 그래서 여기서는 **REG 한 번**만 보낸다. 종목 수 제한은 부르는 쪽
   * (`realtimeHub` 의 `MAX_CODES`)이 지킨다 — 여기서 또 자르면 무엇이 잘렸는지
   * 아무도 모르게 된다.
   */
  private flush(): void {
    if (!this.ws || this.ws.readyState !== 1) return;

    /*
     * ⚠️ **그룹당 200쌍을 넘기지 않는다** (2026-08-31 — 실측으로 재발 확인).
     *
     * 키움은 한 `grp_no` 에 200종목까지만 받는다. 넘으면 `105118` 로 **그 REG 가
     * 통째로 거절**되는데, 소켓은 「연결됨·healthy」라 화면상으로는 멀쩡해 보인다 —
     * 제일 알아채기 어려운 실패다.
     *
     * 위 주석들은 「flush 가 200개씩 그룹을 나눈다」고 적고 있었지만 **실제로는
     * 안 나누고 있었다.** 전부 `grp_no: "1"` 하나로 보냈다. 2026-08-31 09:01 에
     * 구독이 212 로 늘자 그대로 거절이 떴다.
     *
     * `(타입, 종목)` 쌍을 세어 200 마다 그룹 번호를 올린다. 한 타입이 200 을 넘으면
     * 그 타입 안에서도 쪼갠다 — 종목 200개에 세 타입이면 600쌍이다.
     */
    const CHUNK = 200;
    const groups: { item: string[]; type: string[] }[][] = [];
    let cur: { item: string[]; type: string[] }[] = [];
    let count = 0;
    for (const [type, items] of this.pending) {
      const all = [...items];
      for (let i = 0; i < all.length; i += CHUNK) {
        let slice = all.slice(i, i + CHUNK);
        while (slice.length > 0) {
          const room = CHUNK - count;
          const take = slice.slice(0, room);
          slice = slice.slice(room);
          cur.push({ item: take, type: [type] });
          count += take.length;
          if (count >= CHUNK) {
            groups.push(cur);
            cur = [];
            count = 0;
          }
        }
      }
    }
    if (cur.length > 0) groups.push(cur);
    this.pending.clear();
    if (groups.length === 0) return;

    /*
     * `refresh: "1"` 은 **첫 그룹에만.** 그 값은 「기존 등록을 지우고 새로」라는 뜻이라
     * 그룹마다 주면 앞 그룹이 방금 등록한 것을 다음 그룹이 지운다.
     *
     * ⚠️ **연달아 보내면 안 된다** (2026-08-31 — 그룹 분할을 넣자마자 겪었다).
     *
     * 200쌍씩 나누면 REG 가 여러 번 나가는데, 한 번에 몰아 보내면 `105110`
     * 「해당 TRNM 으로 허용된 요청 건수를 초과」가 뜬다. 상한을 피하려고 나눴는데
     * 나누는 행위 자체가 다른 상한에 걸린 것이다.
     *
     * 그룹 사이에 간격을 둔다. 등록이 몇 백 밀리초 늦어도 화면은 모르지만,
     * 거절되면 그 그룹은 **통째로 안 걸린다.**
     */
    const GAP_MS = 400;
    groups.forEach((data, i) => {
      const payload = {
        trnm: "REG",
        grp_no: String(i + 1),
        refresh: i === 0 ? "1" : "0",
        data,
      };
      for (const d of data) for (const it of d.item) this.groupOf.set(`${d.type[0]}:${it}`, payload.grp_no);
      if (i === 0) this.send(payload);
      else setTimeout(() => this.send(payload), i * GAP_MS);
    });
  }

  unsubscribe(type: string, item: string): void {
    this.subs.get(type)?.delete(item);
    if (this.ws && this.ws.readyState === 1) {
      /*
       * **등록했던 그 그룹에만** 보낸다 (2026-08-31).
       *
       * 전 그룹에 뿌리면 REG 와 같은 `105110`(요청 건수 초과)에 걸린다. 어느 그룹에
       * 넣었는지는 `flush` 가 적어 뒀다. 기록이 없으면(아직 안 나간 구독) 1번으로
       * 보낸다 — 다음 `flush` 가 `refresh:"1"` 로 전체를 다시 짜므로 해가 없다.
       */
      const key = `${type}:${item}`;
      this.send({
        trnm: "REMOVE",
        grp_no: this.groupOf.get(key) ?? "1",
        data: [{ item: [item], type: [type] }],
      });
      this.groupOf.delete(key);
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ws?.close();
    this.ws = null;
  }

  /**
   * 구독을 **전부 백지로** — 국면 전환(낮↔저녁↔밤)에서만 부른다.
   *
   * `close()` 는 일부러 구독을 남긴다(재연결 때 그대로 되걸어야 하니까).
   * 하지만 밤이 되어 국내 190 을 미국 FE 로 갈아끼울 때는 **남아 있으면 안 된다** —
   * 재연결 순간 `resubscribe` 가 옛 목록을 다시 걸어 정원 200 이 터진다.
   * 끊은 뒤 이걸 부르고, 새 판을 처음부터 짠다.
   */
  resetSubscriptions(): void {
    this.subs.clear();
    this.keep.clear();
    this.transient.length = 0;
    this.pending.clear();
  }

  /** REG 가 거절된 기록 — 여기 뭐가 있으면 「연결은 됐는데 안 온다」의 원인이다 */
  private readonly regErrors: { at: string; code: number; msg: string }[] = [];
  get registrationErrors(): { at: string; code: number; msg: string }[] {
    return [...this.regErrors];
  }

  get state(): string {
    if (!this.ws) return "끊김";
    return ["연결 중", "연결됨", "닫는 중", "닫힘"][this.ws.readyState] ?? "알 수 없음";
  }
}
