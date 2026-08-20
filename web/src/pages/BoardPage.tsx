import { useCallback, useEffect, useRef, useState } from "react";
import { api, pickList, type RawRecord } from "../api";
import { InvestorTrendTable } from "../components/InvestorTrendTable";
import { ChartPanel } from "../components/ChartPanel";
import { OrderBookPanel } from "../components/OrderBookPanel";
import { BrokerFlowPanel } from "../components/BrokerFlowPanel";
import { ProgramFlowPanel } from "../components/ProgramFlowPanel";
import { OpinionPanel } from "../components/OpinionPanel";
import { SupplyDetailPanel } from "../components/SupplyDetailPanel";
import { SignalPanel } from "../components/SignalLight";
import { ChartInsights } from "../components/ChartInsights";
import { IntradayFlow } from "../components/IntradayPanels";
import { NewsList, DisclosureList } from "../components/NewsDisclosurePanel";
import { FinancePanel } from "../components/FinancePanel";
import { CompanySnapshot } from "../components/CompanySnapshot";
import { SectorMoodPanel } from "../components/SectorMoodPanel";
import { StockNotes } from "../components/StockNotes";
import { BreadthPanel } from "../components/BreadthPanel";
import { MarketSignalPanel } from "../components/MarketSignalPanel";
import { MarketPulsePanel } from "../components/MarketPulsePanel";
import { SectorFlowPanel } from "../components/SectorFlowPanel";
import { useStockFocus } from "../useStockFocus";
import { BoardCell, type CellSize } from "../components/BoardCell";

/**
 * 보드 — **다른 창에서 고른 종목을 따라 그린다.**
 *
 * ## 왜 따로 있나
 *
 * 종목발굴이나 순위 화면은 「고르는 자리」다. 거기서 종목을 하나씩 눌러 보며
 * 차트와 수급을 같이 보려면 창을 계속 열었다 닫아야 한다.
 * 모니터가 여러 대면 **한쪽은 고르고 한쪽은 보는** 게 자연스러운데, 브라우저 창은
 * 서로 남남이라 그게 저절로 안 된다. 이 화면이 받는 쪽이다.
 *
 * ## 쓰는 법
 *
 *   1. 이 창에서 **연동을 켠다**
 *   2. 다른 창(다른 모니터)에서도 연동을 켜고 종목을 누른다
 *   3. 이 창이 그 종목으로 바뀐다
 *
 * ## 무엇을 띄울지는 고른다
 *
 * 여섯 개를 다 켜면 한 화면에 안 들어온다. **보고 싶은 것만** 켜서 모니터 크기에
 * 맞추는 게 맞다 — 27인치 한 대와 노트북은 담을 수 있는 양이 다르다.
 * 고른 것은 이 기기에만 남는다.
 */

/**
 * 투자자 수급만 **스스로 받아 온다.**
 *
 * 다른 칸들은 `code` 만 주면 알아서 그리는데, 투자자 수급표는 종목 상세가 받아 둔
 * 값을 얻어 쓰는 구조라 여기서는 쓸 수가 없다. 표를 고치면 상세 화면까지 흔들리므로
 * **받아 오는 껍데기만** 여기에 둔다.
 */
function InvestorBlock({ code }: { code: string }) {
  const [rows, setRows] = useState<RawRecord[] | null>(null);

  useEffect(() => {
    let alive = true;
    setRows(null);
    api
      .investorChart(code)
      .then((r) => {
        if (alive) setRows(pickList(r as RawRecord, ["stk_invsr_orgn_chart"]));
      })
      .catch(() => {
        if (alive) setRows([]);
      });
    return () => {
      alive = false;
    };
  }, [code]);

  if (rows === null) return <div className="empty">불러오는 중…</div>;
  return <InvestorTrendTable rows={rows} />;
}

/**
 * 종목 기본정보를 받아 두는 껍데기.
 *
 * 「기업분석」과 「장중 수급」은 `code` 만으로는 못 그린다 — 시가총액·기준가 같은
 * 값이 필요한데 그건 종목 상세가 따로 받아 두는 것이다.
 * 두 칸이 각자 받으면 같은 걸 두 번 받게 되므로 여기서 한 번 받아 나눠 준다.
 */
function useStockInfo(code: string): RawRecord | null {
  const [info, setInfo] = useState<RawRecord | null>(null);
  useEffect(() => {
    let alive = true;
    setInfo(null);
    if (!code) return;
    api
      .stockInfo(code)
      .then((r) => {
        if (alive) setInfo(r as RawRecord);
      })
      .catch(() => {
        if (alive) setInfo(null);
      });
    return () => {
      alive = false;
    };
  }, [code]);
  return info;
}

/**
 * 보드에 띄울 수 있는 칸.
 *
 * **종목 상세에서 볼 수 있는 것은 다 있어야 한다.** 보드를 띄워 두고 다른 창에서
 * 종목만 바꿔 가며 보는 자리인데, 여기서 못 보는 게 있으면 결국 상세 창을 또 열게 되고
 * 그러면 보드를 쓸 이유가 없어진다.
 *
 * 순서는 **자주 보는 것부터**다 — 처음 켰을 때 위에서부터 고르게 된다.
 */
const BLOCKS = [
  /*
   * **종목과 무관한 칸**(`market: true`).
   *
   * 여기가 없어서 보드로 HTS 1·3번 모니터를 못 흉내 냈다 — 지수판·시장 수급 같은 건
   * 종목이 바뀌어도 안 바뀌는 것들인데, 모든 칸이 종목에 매여 있었다.
   * 연동이 꺼져 있거나 종목이 아직 안 왔을 때도 **이 칸들은 그려진다.**
   */
  { key: "mktSignal", label: "시장 신호등", wide: false },
  { key: "mktPulse", label: "시장 맥박", wide: false },
  { key: "mktBreadth", label: "상승·하락 종목수", wide: false },
  { key: "mktSector", label: "업종 수급", wide: true },

  { key: "chart", label: "차트", wide: true },
  { key: "insights", label: "이동평균·매물대", wide: false },
  { key: "signal", label: "신호등", wide: false },
  { key: "orderbook", label: "호가", wide: false },
  { key: "intraday", label: "장중 수급", wide: false },
  { key: "investor", label: "투자자 수급", wide: false },
  { key: "broker", label: "거래원", wide: false },
  { key: "program", label: "프로그램", wide: false },
  { key: "supply", label: "공매도·대차", wide: false },
  { key: "opinion", label: "목표주가", wide: false },
  { key: "news", label: "뉴스", wide: false },
  { key: "disclosure", label: "공시", wide: false },
  { key: "finance", label: "재무", wide: false },
  { key: "summary", label: "기업분석", wide: false },
  { key: "sector", label: "업종·테마", wide: false },
  { key: "notes", label: "메모", wide: false },
] as const;

type BlockKey = (typeof BLOCKS)[number]["key"];

/**
 * 종목과 무관한 칸.
 *
 * 블록 객체에 표시를 달면 `as const` 때문에 어떤 항목에만 그 속성이 생겨서
 * 타입이 갈린다. 키 목록으로 두는 편이 단순하다.
 */
const MARKET_KEYS = new Set<string>(["mktSignal", "mktPulse", "mktBreadth", "mktSector"]);
const isMarket = (k: string) => MARKET_KEYS.has(k);

/*
 * 칸 크기 — **기기마다 따로.**
 * 27인치와 노트북이 같을 수 없으니 서버에 두면 한쪽에 맞춘 크기가 다른 쪽을 망친다.
 */
const SIZE_KEY = "vntg.board.sizes";

function readSizes(): Record<string, CellSize> {
  try {
    const raw = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "null") as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, CellSize> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const s = v as { w?: unknown; h?: unknown };
      const w = Number(s?.w);
      const h = Number(s?.h);
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) out[k] = { w, h };
    }
    return out;
  } catch {
    return {};
  }
}

const PIN_KEY = "vntg.board.pins";

/**
 * 칸마다 붙들어 둔 종목.
 *
 * 안 붙들면 연동을 따라가고, 붙들면 그 종목에 머문다. HTS 로 치면 한 창에서
 * 삼성전자를 파면서 옆 창은 하이닉스를 띄워 두는 것 — 보드가 종목 하나만 보던
 * 구조로는 못 하던 일이다.
 *
 * **구성에 담는다.** 「종목은 안 담는다」던 원칙의 예외인데, 붙들어 둔 종목은
 * 「지금 보는 종목」이 아니라 **그 배치의 일부**이기 때문이다 — 감시용 배치라면
 * 늘 같은 종목을 보고 있어야 뜻이 있다.
 */
const LOCK_KEY = "vntg.board.locks";

function readLocks(): Record<string, { code: string; name: string }> {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCK_KEY) ?? "null") as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, { code: string; name: string }> = {};
    for (const [k, v] of Object.entries(raw as Record<string, { code?: unknown; name?: unknown }>)) {
      if (typeof v?.code === "string" && v.code) {
        out[k] = { code: v.code, name: typeof v.name === "string" ? v.name : v.code };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 화면 구성 네 벌 — **즐겨찾기처럼.**
 *
 * 장중에 보는 구성과 마감 뒤에 보는 구성이 다르고, 종목을 고를 때와 파고들 때가 또
 * 다르다. 그때마다 칸을 켜고 끄고 크기를 다시 잡는 건 **하던 일을 멈추는 것**이라,
 * 몇 벌 만들어 두고 숫자 하나로 갈아 끼우는 편이 낫다.
 *
 * 담는 것은 「무엇을·어떤 순서로·얼마나 크게·어디를 고정했나」 넷이다.
 * 종목은 안 담는다 — 구성은 **틀**이지 내용이 아니다.
 */
const PRESET_KEY = "vntg.board.presets";

/**
 * 처음 쓸 때 깔아 두는 세 벌 — **모니터 세 대를 쓰던 HTS 구조**를 옮긴 것.
 *
 * 창을 셋 띄우고 각각 다른 구성을 불러오면 그 배치가 재현된다.
 * 종목을 고르는 창에서 누르면 「종목 파기」 창만 따라오고 나머지는 안 흔들린다.
 *
 * 시장 신호등·맥박·상승하락 종목수·업종 수급은 **종목과 무관한 칸**이라
 * 연동이 꺼져 있어도 그려진다 — HTS 1번 모니터가 하던 일이 그것이다.
 * (아직 없는 것: 지수판 여러 장, 관심종목 다종목 시세판)
 *
 * **한 번 깔고 나면 사용자 것**이다 — 이름도 순서도 개수도 여기서 정하지 않는다.
 */
const SEED: Preset[] = [
  { id: "k1", name: "K1 시장 보기", pick: ["mktSignal", "mktPulse", "mktBreadth", "mktSector", "news"], sizes: {}, pins: [] },
  { id: "k2", name: "K2 종목 파기", pick: ["chart", "orderbook", "investor", "broker", "supply", "opinion", "finance", "summary"], sizes: {}, pins: [] },
  { id: "k3", name: "K3 장중 감시", pick: ["mktBreadth", "signal", "intraday", "program", "orderbook"], sizes: {}, pins: [] },
];

interface Preset {
  id: string;
  name: string;
  pick: string[];
  sizes: Record<string, CellSize>;
  pins: string[];
  /** 칸마다 붙들어 둔 종목 — 배치의 일부다 */
  locks?: Record<string, { code: string; name: string }>;
}

/**
 * 저장된 구성을 읽는다.
 *
 * 예전에는 K1~K4 네 칸으로 **고정**돼 있었다(`{K1:{...}}` 모양).
 * 그 모양이 남아 있으면 목록으로 옮긴다 — 쓰던 구성을 잃으면 안 된다.
 */
function readPresets(): Preset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PRESET_KEY) ?? "null") as unknown;
    if (Array.isArray(raw)) {
      const out = raw
        .filter((p): p is Preset => Boolean(p) && typeof (p as Preset).id === "string")
        .map((p) => ({ ...p, name: p.name || p.id, pick: p.pick ?? [], sizes: p.sizes ?? {}, pins: p.pins ?? [] }));
      return out.length > 0 ? out : SEED;
    }
    // 옛 모양 → 목록으로
    if (raw && typeof raw === "object") {
      const out: Preset[] = [];
      for (const [k, v] of Object.entries(raw as Record<string, Partial<Preset>>)) {
        // 예전 슬롯은 이름이 없어서 「1」「K2」로 보였다 — 사람이 읽을 이름을 준다
        const nice = v?.name || (/^\d+$/.test(k) ? `구성 ${k}` : k);
        out.push({ id: k, name: nice, pick: v?.pick ?? [], sizes: v?.sizes ?? {}, pins: v?.pins ?? [] });
      }
      if (out.length > 0) return out;
    }
    return SEED;
  } catch {
    return SEED;
  }
}

const PICK_KEY = "vntg.board.blocks";
const DEFAULT_PICK: BlockKey[] = ["chart", "investor", "supply", "opinion"];

function readPick(): BlockKey[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PICK_KEY) ?? "null") as unknown;
    if (!Array.isArray(raw)) return DEFAULT_PICK;
    const keys = new Set(BLOCKS.map((b) => b.key as string));
    const out = raw.filter((k): k is BlockKey => typeof k === "string" && keys.has(k));
    return out.length > 0 ? out : DEFAULT_PICK;
  } catch {
    return DEFAULT_PICK;
  }
}

/**
 * 구성에 든 패널을 사람 말로.
 *
 * 「15칸」은 개수만 알려 줄 뿐 **무엇이 들었는지는 안 알려 준다** — 12칸짜리와
 * 뭐가 다른지 알려면 결국 눌러 봐야 했다. 앞의 셋을 이름으로 적고 나머지는 세어 준다.
 */
function summarize(pick: string[]): string {
  const names: string[] = [];
  for (const k of pick) {
    const label = BLOCKS.find((b) => b.key === k)?.label;
    if (label) names.push(label);
  }
  if (names.length === 0) return "빈 구성";
  const head = names.slice(0, 3).join("·");
  return names.length > 3 ? `${head} 외 ${names.length - 3}개` : head;
}

export function BoardPage({ onSelectStock }: { onSelectStock?: (c: string, n: string) => void }) {
  const { on, toggle, focus } = useStockFocus();
  const [pick, setPick] = useState<BlockKey[]>(readPick);
  const [sizes, setSizes] = useState<Record<string, CellSize>>(readSizes);

  const setSize = useCallback((key: string, s: CellSize) => {
    setSizes((prev) => {
      const had = prev[key];
      if (had && had.w === s.w && had.h === s.h) return prev;
      const next = { ...prev, [key]: s };
      try {
        localStorage.setItem(SIZE_KEY, JSON.stringify(next));
      } catch {
        /* 저장 못 해도 이번 세션에는 그 크기로 본다 */
      }
      return next;
    });
  }, []);

  const resetSizes = useCallback(() => {
    setSizes({});
    try {
      localStorage.removeItem(SIZE_KEY);
    } catch {
      /* 무시 */
    }
  }, []);

  /* ---------------- 고정 ---------------- */
  const [pins, setPins] = useState<string[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(PIN_KEY) ?? "[]") as unknown;
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  });

  const [locks, setLocks] = useState<Record<string, { code: string; name: string }>>(readLocks);

  const persistLocks = useCallback((next: Record<string, { code: string; name: string }>) => {
    setLocks(next);
    try {
      localStorage.setItem(LOCK_KEY, JSON.stringify(next));
    } catch {
      /* 무시 */
    }
  }, []);

  /* 끄는 도중에 읽어야 해서 ref 로도 들고 있는다 */
  const pinsRef = useRef<string[]>(pins);
  useEffect(() => {
    pinsRef.current = pins;
  }, [pins]);

  const flipPin = useCallback((k: string) => {
    setPins((prev) => {
      const next = prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k];
      try {
        localStorage.setItem(PIN_KEY, JSON.stringify(next));
      } catch {
        /* 무시 */
      }
      return next;
    });
  }, []);

  /* ---------------- 자리 바꾸기 ---------------- */
  const [dragKey, setDragKey] = useState<string | null>(null);

  /*
   * 끄는 동안 **실시간으로 자리를 바꾼다.**
   *
   * 놓을 때 한 번에 옮기면 어디에 떨어질지 모르는 채로 끌게 된다. 지나가는 칸과
   * 즉시 자리를 바꾸면 결과가 눈앞에서 보이므로 미리보기가 따로 필요 없다.
   *
   * 고정된 칸은 **자리를 내주지 않는다** — 고정의 뜻이 그것이다.
   */
  const onDragStart = useCallback(
    (key: string) => (e: React.PointerEvent) => {
      e.preventDefault();
      setDragKey(key);

      const move = (ev: PointerEvent) => {
        const under = document
          .elementFromPoint(ev.clientX, ev.clientY)
          ?.closest<HTMLElement>(".board-cell");
        const over = under?.dataset.cell;
        if (!over || over === key) return;
        /*
         * 고정 목록은 **ref 로 읽는다.**
         *
         * 처음엔 `setPins` 갱신 함수 안에서 `setPick` 을 불렀는데, 그건 React 가
         * 보장하지 않는 자리라 **아무 일도 안 일어났다** — 끌어도 순서가 그대로였다.
         * 갱신 함수는 값을 계산해서 돌려주는 곳이지 다른 상태를 건드리는 곳이 아니다.
         */
        if (pinsRef.current.includes(over)) return; // 고정된 칸은 안 밀린다
        setPick((cur) => {
          const from = cur.indexOf(key as BlockKey);
          const to = cur.indexOf(over as BlockKey);
          if (from < 0 || to < 0 || from === to) return cur;
          const next = [...cur];
          next.splice(to, 0, next.splice(from, 1)[0]);
          return next;
        });
      };
      const up = () => {
        setDragKey(null);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);

      /*
       * 포인터 캡처는 **맨 마지막에, 실패해도 그만인 것으로** 건다.
       *
       * 처음엔 리스너보다 먼저 불렀는데, 이게 예외를 던지면 **그 뒤 줄이 통째로 안
       * 돌아서** 리스너가 하나도 안 붙었다 — 끌어도 아무 반응이 없던 게 이것이다.
       * 캡처는 손가락이 칸 밖으로 나가도 따라오게 하는 편의 장치일 뿐이고,
       * 어차피 `window` 에서 듣고 있으므로 없어도 동작한다.
       */
      try {
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      } catch {
        /* 못 걸어도 window 에서 듣는다 */
      }
    },
    [],
  );

  /* ---------------- 화면 구성 (목록) ---------------- */
  const [presets, setPresets] = useState<Preset[]>(readPresets);
  const [editing, setEditing] = useState(false);

  /*
   * **기본 세 벌을 처음 한 번 저장해 둔다.**
   *
   * 예전엔 저장 없이 보여주기만 했다. 화면에는 K1·K2·K3 이 멀쩡히 있는데
   * 저장소는 비어 있어서, 이름을 고치거나 하나를 지우면 **나머지가 갑자기 나타나거나
   * 사라지는 것처럼** 보였다 — 「저장이 안 된다」는 말이 그 뜻이었다.
   * 보이는 것과 저장된 것이 처음부터 같아야 한다.
   */
  useEffect(() => {
    if (localStorage.getItem(PRESET_KEY)) return;
    try {
      localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
    } catch {
      /* 무시 */
    }
    // 처음 한 번만
  }, []);

  const persist = useCallback((next: Preset[]) => {
    setPresets(next);
    try {
      localStorage.setItem(PRESET_KEY, JSON.stringify(next));
    } catch {
      /* 저장 못 해도 이번 세션에는 쓴다 */
    }
  }, []);

  /** 지금 화면을 그 구성에 덮어쓴다 */
  const saveInto = useCallback(
    (id: string) => {
      persist(presets.map((p) => (p.id === id ? { ...p, pick, sizes, pins, locks } : p)));
    },
    [persist, presets, pick, sizes, pins, locks],
  );

  /** 지금 화면을 새 구성으로 */
  const addPreset = useCallback(() => {
    /*
     * 이름을 **만들 때** 받는다. 「구성 4」로 만들어 놓고 편집에서 고치게 하면
     * 대부분 그냥 두게 되고, 그러면 이름이 있으나 마나가 된다.
     */
    const name = window.prompt("새 구성 이름", `구성 ${presets.length + 1}`);
    if (name === null) return;
    const id = `p${Date.now().toString(36)}`;
    persist([...presets, { id, name: name.trim() || `구성 ${presets.length + 1}`, pick, sizes, pins, locks }]);
  }, [persist, presets, pick, sizes, pins, locks]);

  const rename = useCallback(
    (id: string, name: string) => persist(presets.map((p) => (p.id === id ? { ...p, name } : p))),
    [persist, presets],
  );

  const remove = useCallback(
    (id: string) => persist(presets.filter((p) => p.id !== id)),
    [persist, presets],
  );

  /** 한 칸 앞/뒤로 — 자주 쓰는 걸 왼쪽에 두게 된다 */
  const move = useCallback(
    (id: string, delta: -1 | 1) => {
      const at = presets.findIndex((p) => p.id === id);
      const to = at + delta;
      if (at < 0 || to < 0 || to >= presets.length) return;
      const next = [...presets];
      [next[at], next[to]] = [next[to], next[at]];
      persist(next);
    },
    [persist, presets],
  );

  const loadFrom = useCallback(
    (id: string) => {
      const p = presets.find((x) => x.id === id);
      if (!p) return;
      const keys = new Set(BLOCKS.map((b) => b.key as string));
      const nextPick = (p.pick ?? []).filter((k): k is BlockKey => keys.has(k));
      setPick(nextPick.length > 0 ? nextPick : DEFAULT_PICK);
      setSizes(p.sizes ?? {});
      setPins(p.pins ?? []);
      persistLocks(p.locks ?? {});
      try {
        localStorage.setItem(PICK_KEY, JSON.stringify(nextPick));
        localStorage.setItem(SIZE_KEY, JSON.stringify(p.sizes ?? {}));
        localStorage.setItem(PIN_KEY, JSON.stringify(p.pins ?? []));
      } catch {
        /* 무시 */
      }
    },
    [presets, persistLocks],
  );

  useEffect(() => {
    try {
      localStorage.setItem(PICK_KEY, JSON.stringify(pick));
    } catch {
      /* 저장 못 해도 이번 세션에는 그대로 쓴다 */
    }
  }, [pick]);

  const flip = (k: BlockKey) =>
    setPick((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));

  const code = focus?.code ?? "";
  const name = focus?.name ?? "";
  /* 칸 안에서 쓰는 이름 — 칸마다 종목이 다를 수 있어서 바깥 것과 헷갈리면 안 된다 */
  const focusCode = code;
  const focusName = name;
  /* 기업분석·장중 수급이 쓴다. 한 번 받아 두 칸이 나눠 쓴다 */
  const info = useStockInfo(code);

  /*
   * 설정 줄은 **접어 둘 수 있다.**
   *
   * 한 번 맞추고 나면 다시 볼 일이 거의 없는데, 펼친 채로 두면 화면 위쪽 두세 줄을
   * 늘 잡아먹는다. 보드는 **본문을 넓게 보려고 만든 화면**이라 그 자리가 아깝다.
   * 접힌 상태를 기억해서 다음에 들어와도 넓은 채로 시작한다.
   */
  const [cfgOpen, setCfgOpen] = useState(() => {
    try {
      return localStorage.getItem("vntg.board.cfgOpen") !== "0";
    } catch {
      return true;
    }
  });
  const toggleCfg = useCallback(() => {
    setCfgOpen((v) => {
      try {
        localStorage.setItem("vntg.board.cfgOpen", v ? "0" : "1");
      } catch {
        /* 무시 */
      }
      return !v;
    });
  }, []);

  return (
    <div className="board">
      <section className="card board-cfg">
        {/*
          접었을 때도 **지금 무슨 종목인지와 연동 상태**는 남는다.
          그 둘은 화면을 보는 내내 알아야 하는 값이라 설정이 아니다.
        */}
        <h2 className="board-cfg-h">
          <span>
            보드
            {code && (
              <span className="pt-n">
                {" "}
                지금 {name} ({code})
              </span>
            )}
            {!on && <span className="board-off"> 연동 꺼짐</span>}
          </span>
          <button className="filter-btn board-cfg-btn" onClick={toggleCfg}>
            {cfgOpen ? "설정 접기" : "⚙ 설정"}
          </button>
        </h2>

        {cfgOpen && (
        <>
        <div className="filter-row">
          <label className="st-cfg-chk">
            <input type="checkbox" checked={on} onChange={(e) => toggle(e.target.checked)} />
            <b>종목 연동</b>
          </label>
          <span className="pt-n">
            {on
              ? "다른 창에서 종목을 누르면 이 화면이 따라옵니다"
              : "꺼져 있습니다 — 켜야 다른 창을 따라갑니다"}
          </span>
        </div>

        <div className="filter-row">
          {BLOCKS.map((b) => (
            <button
              key={b.key}
              className={`filter-btn ${pick.includes(b.key) ? "active" : ""}`}
              onClick={() => flip(b.key)}
            >
              {b.label}
            </button>
          ))}
          {Object.keys(sizes).length > 0 && (
            <button className="filter-btn" onClick={resetSizes}>
              크기 초기화
            </button>
          )}
        </div>

        {/*
          화면 구성 — **개수도 이름도 순서도 내가 정한다.**

          편집을 같은 줄에 욱여넣었더니 이름칸·화살표·삭제가 다닥다닥 붙어서 누르기가
          어려웠다. 편집은 **아래로 펼쳐서 한 줄에 하나씩** 둔다 — 평소에는 이름만
          늘어놓고, 고칠 때만 자리를 내준다.
        */}
        <div className="filter-row">
          <span className="st-cfg-k">화면 구성</span>
          {presets.map((p) => (
            <button
              key={p.id}
              className="filter-btn"
              onClick={() => loadFrom(p.id)}
              title={`${p.name} — ${summarize(p.pick)}`}
            >
              {p.name}
            </button>
          ))}
          <button className="filter-btn" onClick={addPreset} title="지금 화면을 새 구성으로 담기">
            ＋ 새로 담기
          </button>
          <button
            className={`filter-btn ${editing ? "active" : ""}`}
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "편집 끝" : "✏ 편집"}
          </button>
        </div>

        {editing && (
          <div className="bp-list">
            {presets.length === 0 && <div className="empty">담아 둔 구성이 없습니다.</div>}
            {presets.map((p, i) => (
              <div className="bp-row" key={p.id}>
                <span className="bp-ord">
                  <button className="gt-move" onClick={() => move(p.id, -1)} disabled={i === 0} title="위로">
                    ▲
                  </button>
                  <button
                    className="gt-move"
                    onClick={() => move(p.id, 1)}
                    disabled={i === presets.length - 1}
                    title="아래로"
                  >
                    ▼
                  </button>
                </span>
                <input
                  className="bp-name"
                  value={p.name}
                  onChange={(e) => rename(p.id, e.target.value)}
                  placeholder="구성 이름"
                />
                {/*
                  개수만 적으면 「15칸」과 「12칸」의 차이를 알려면 눌러 봐야 한다.
                  앞의 몇 개를 이름으로 보여 주면 불러오기 전에 무엇이 든 구성인지 안다.
                */}
                <span className="bp-meta">{summarize(p.pick)}</span>
                <button
                  className="filter-btn"
                  onClick={() => saveInto(p.id)}
                  title="지금 화면 배치를 이 구성에 덮어쓰기"
                >
                  지금 화면으로 덮기
                </button>
                <button className="row-del-btn" onClick={() => remove(p.id)} title="이 구성 삭제">
                  ✕
                </button>
              </div>
            ))}
            <div className="table-note">
              이름은 적는 대로 저장됩니다. <b>덮기</b>는 지금 보고 있는 배치(칸·크기·고정·
              종목 고정)를 그 구성에 넣습니다.
            </div>
          </div>
        )}

        <div className="table-note">
          칸 제목의 <b>⠿</b>를 끌어 자리를 바꾸고, <b>오른쪽 아래 모서리</b>를 끌어 크기를
          바꿉니다. 다 맞췄으면 <b>📍</b>를 눌러 고정하세요 — 고정한 칸은 크기도 자리도
          안 움직입니다. <b>화면 구성</b>은 틀만 담습니다(종목은 안 담습니다) — <b>✏ 편집</b>에서 이름·순서를
          바꾸고 지우고, <b>＋</b>로 지금 화면을 새 구성으로 담을 수 있습니다. 모두 이 기기에만
          남습니다.
        </div>
        </>
        )}

        {/* 아래 둘은 접어도 남는다 — 「왜 아무것도 안 뜨나」의 답이라 설정이 아니다 */}
        {!on && (
          <div className="alert-note">
            연동을 켜세요. <b>보내는 창에서도</b> 켜야 합니다 — 메뉴 맨 아래 📡 버튼입니다.
          </div>
        )}
        {on && !code && (
          <div className="empty">
            다른 창에서 종목을 고르면 여기에 뜹니다.
            <br />
            <span className="pt-n">
              같은 브라우저의 창은 즉시, 다른 기기는 1~2초 안에 따라옵니다.
            </span>
          </div>
        )}
      </section>

      {/*
        **시장 칸은 종목이 없어도 그린다.**
        종목과 무관한 칸만 켜 둔 구성(K1 같은)에서 연동이 아직 안 왔다고
        화면이 통째로 비면 그 구성은 쓸 수가 없다.
      */}
      {(code || pick.some(isMarket)) && (
        <div className="board-grid">
          {/*
            **`pick` 순서대로** 그린다. 예전엔 `BLOCKS` 를 훑어 걸러냈는데,
            그러면 자리를 바꿔도 늘 원래 순서로 되돌아갔다 — 옮긴 결과가 안 보였다.
          */}
          {pick
            .map((k) => BLOCKS.find((b) => b.key === k))
            .filter((b): b is (typeof BLOCKS)[number] => Boolean(b))
            .map((b) => (
            <BoardCell
              key={b.key}
              cellKey={b.key}
              title={b.label}
              sub={isMarket(b.key) ? undefined : (locks[b.key]?.name ?? name)}
              wide={b.wide}
              locked={isMarket(b.key) ? null : (locks[b.key] ?? null)}
              onToggleLock={isMarket(b.key) ? undefined : () => {
                /*
                 * 잠글 땐 **지금 이 칸이 보고 있는 종목**을 붙든다.
                 * 연동으로 흘러온 종목이 곧 사람이 보고 있는 것이므로,
                 * 따로 고르게 하지 않아도 뜻이 맞는다.
                 */
                const next = { ...locks };
                if (next[b.key]) delete next[b.key];
                else if (code) next[b.key] = { code, name };
                persistLocks(next);
              }}
              size={sizes[b.key] ?? null}
              onSize={(s) => setSize(b.key, s)}
              pinned={pins.includes(b.key)}
              onPin={() => flipPin(b.key)}
              onDragStart={onDragStart(b.key)}
              dragging={dragKey === b.key}
            >
              {({ height, tick }) => {
                /* 붙들어 뒀으면 그 종목, 아니면 연동을 따라간다 */
                const lock = locks[b.key];
                const code = lock?.code ?? focusCode;
                const name = lock?.name ?? focusName;
                if (!isMarket(b.key) && !code) return <div className="empty">종목 없음</div>;
                return (
                <>
                  {b.key === "mktSignal" && <MarketSignalPanel />}
                  {b.key === "mktPulse" && <MarketPulsePanel />}
                  {b.key === "mktBreadth" && <BreadthPanel />}
                  {b.key === "mktSector" && <SectorFlowPanel onSelectStock={onSelectStock} />}
                  {/*
                    `key={code}` 를 준다. 종목이 바뀌면 패널을 **새로 만든다** —
                    안 그러면 어떤 패널은 이전 종목의 값을 그대로 들고 있다가
                    자기 주기에 맞춰 뒤늦게 갱신되어, 잠깐 **다른 종목의 숫자**가 보인다.
                    보드는 여러 칸을 동시에 보는 화면이라 그 어긋남이 바로 눈에 띈다.
                  */}
                  {b.key === "chart" && (
                    /*
                      차트만 높이를 받아 간다. 표는 칸이 커지면 알아서 늘어나지만
                      캔버스는 그렇지 않아서, 알려 주지 않으면 여백만 생긴다.
                      판독 줄이 아래 붙으므로 그만큼 뺀다.
                    */
                    <ChartPanel
                      key={code}
                      code={code}
                      name={name}
                      height={Math.max(140, height - 150)}
                      sizeTick={tick}
                    />
                  )}
                  {b.key === "insights" && <ChartInsights key={code} code={code} />}
                  {b.key === "signal" && (
                    <SignalPanel key={code} code={code} onSelectStock={onSelectStock} />
                  )}
                  {b.key === "orderbook" && <OrderBookPanel key={code} code={code} />}
                  {b.key === "intraday" && (
                    <IntradayFlow
                      key={code}
                      code={code}
                      basePrice={Math.abs(Number(info?.base_pric)) || 0}
                    />
                  )}
                  {b.key === "investor" && <InvestorBlock key={code} code={code} />}
                  {b.key === "broker" && <BrokerFlowPanel key={code} code={code} />}
                  {b.key === "program" && <ProgramFlowPanel key={code} code={code} />}
                  {b.key === "supply" && <SupplyDetailPanel key={code} code={code} />}
                  {b.key === "opinion" && <OpinionPanel key={code} code={code} />}
                  {/* 뉴스는 종목명으로 찾는다 — 코드로는 기사 검색이 안 된다 */}
                  {b.key === "news" && <NewsList key={code} query={name || code} />}
                  {b.key === "disclosure" && <DisclosureList key={code} code={code} />}
                  {b.key === "finance" && <FinancePanel key={code} code={code} />}
                  {b.key === "summary" && (
                    <CompanySnapshot key={code} info={info} returns={null} />
                  )}
                  {b.key === "sector" && (
                    <SectorMoodPanel key={code} code={code} onSelectStock={onSelectStock} />
                  )}
                  {b.key === "notes" && (
                    <StockNotes
                      key={code}
                      code={code}
                      name={name}
                      currentPrice={Math.abs(Number(info?.cur_prc)) || undefined}
                    />
                  )}
                </>
                );
              }}
            </BoardCell>
          ))}
        </div>
      )}

      {code && onSelectStock && (
        <div className="filter-row">
          <button className="filter-btn" onClick={() => onSelectStock(code, name)}>
            {name} 상세 열기
          </button>
        </div>
      )}
    </div>
  );
}
