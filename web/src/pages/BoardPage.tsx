import { useCallback, useEffect, useRef, useState } from "react";
import { api, pickList, type RawRecord } from "../api";
import { InvestorTrendTable } from "../components/InvestorTrendTable";
import { ChartPanel } from "../components/ChartPanel";
import { OrderBookPanel } from "../components/OrderBookPanel";
import { BrokerFlowPanel } from "../components/BrokerFlowPanel";
import { ProgramFlowPanel } from "../components/ProgramFlowPanel";
import { OpinionPanel } from "../components/OpinionPanel";
import { SupplyDetailPanel } from "../components/SupplyDetailPanel";
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
const SLOTS = ["1", "2", "3", "4"] as const;

interface Preset {
  pick: string[];
  sizes: Record<string, CellSize>;
  pins: string[];
}

function readPresets(): Record<string, Preset> {
  try {
    const raw = JSON.parse(localStorage.getItem(PRESET_KEY) ?? "null") as unknown;
    if (!raw || typeof raw !== "object") return {};
    return raw as Record<string, Preset>;
  } catch {
    return {};
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

  /* ---------------- 구성 1~4 ---------------- */
  const [presets, setPresets] = useState<Record<string, Preset>>(readPresets);
  const [saveMode, setSaveMode] = useState(false);

  const saveTo = useCallback(
    (slot: string) => {
      const next = { ...presets, [slot]: { pick, sizes, pins } };
      setPresets(next);
      try {
        localStorage.setItem(PRESET_KEY, JSON.stringify(next));
      } catch {
        /* 무시 */
      }
      setSaveMode(false);
    },
    [presets, pick, sizes, pins],
  );

  const loadFrom = useCallback(
    (slot: string) => {
      const p = presets[slot];
      if (!p) return;
      const keys = new Set(BLOCKS.map((b) => b.key as string));
      const nextPick = (p.pick ?? []).filter((k): k is BlockKey => keys.has(k));
      setPick(nextPick.length > 0 ? nextPick : DEFAULT_PICK);
      setSizes(p.sizes ?? {});
      setPins(p.pins ?? []);
      try {
        localStorage.setItem(PICK_KEY, JSON.stringify(nextPick));
        localStorage.setItem(SIZE_KEY, JSON.stringify(p.sizes ?? {}));
        localStorage.setItem(PIN_KEY, JSON.stringify(p.pins ?? []));
      } catch {
        /* 무시 */
      }
    },
    [presets],
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

  return (
    <div className="board">
      <section className="card">
        <h2>
          보드
          {code && (
            <span className="pt-n">
              {" "}
              지금 {name} ({code})
            </span>
          )}
        </h2>

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

        {/* 화면 구성 네 벌 — 즐겨찾기처럼 갈아 끼운다 */}
        <div className="filter-row">
          <span className="st-cfg-k">화면 구성</span>
          {SLOTS.map((s) => {
            const has = Boolean(presets[s]);
            return (
              <button
                key={s}
                className={`filter-btn ${has && !saveMode ? "active" : ""}`}
                onClick={() => (saveMode ? saveTo(s) : loadFrom(s))}
                disabled={!saveMode && !has}
                title={
                  saveMode
                    ? `지금 구성을 ${s}번에 저장`
                    : has
                      ? `${s}번 구성 불러오기`
                      : `${s}번은 비어 있습니다`
                }
              >
                {saveMode ? `${s}에 저장` : s}
              </button>
            );
          })}
          <button
            className={`filter-btn ${saveMode ? "active" : ""}`}
            onClick={() => setSaveMode((v) => !v)}
          >
            {saveMode ? "취소" : "지금 구성 저장"}
          </button>
        </div>

        <div className="table-note">
          칸 제목의 <b>⠿</b>를 끌어 자리를 바꾸고, <b>오른쪽 아래 모서리</b>를 끌어 크기를
          바꿉니다. 다 맞췄으면 <b>📍</b>를 눌러 고정하세요 — 고정한 칸은 크기도 자리도
          안 움직입니다. 구성은 <b>틀만</b> 담습니다(종목은 안 담습니다). 모두 이 기기에만
          남습니다.
        </div>

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

      {code && (
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
              wide={b.wide}
              size={sizes[b.key] ?? null}
              onSize={(s) => setSize(b.key, s)}
              pinned={pins.includes(b.key)}
              onPin={() => flipPin(b.key)}
              onDragStart={onDragStart(b.key)}
              dragging={dragKey === b.key}
            >
              {({ height, tick }) => (
                <>
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
                  {b.key === "orderbook" && <OrderBookPanel key={code} code={code} />}
                  {b.key === "investor" && <InvestorBlock key={code} code={code} />}
                  {b.key === "broker" && <BrokerFlowPanel key={code} code={code} />}
                  {b.key === "program" && <ProgramFlowPanel key={code} code={code} />}
                  {b.key === "supply" && <SupplyDetailPanel key={code} code={code} />}
                  {b.key === "opinion" && <OpinionPanel key={code} code={code} />}
                </>
              )}
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
