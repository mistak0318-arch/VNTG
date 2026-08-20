import { useCallback, useEffect, useState } from "react";
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

const BLOCKS = [
  { key: "chart", label: "차트", wide: true },
  { key: "orderbook", label: "호가", wide: false },
  { key: "investor", label: "투자자 수급", wide: false },
  { key: "broker", label: "거래원", wide: false },
  { key: "program", label: "프로그램", wide: false },
  { key: "supply", label: "공매도·대차", wide: false },
  { key: "opinion", label: "목표주가", wide: false },
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
        <div className="table-note">
          칸의 <b>오른쪽 아래 모서리</b>를 끌어 크기를 바꿉니다. 바꾼 크기는 이 기기에만
          남습니다 — 모니터마다 알맞은 크기가 다릅니다.
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
          {BLOCKS.filter((b) => pick.includes(b.key)).map((b) => (
            <BoardCell
              key={b.key}
              title={b.label}
              wide={b.wide}
              size={sizes[b.key] ?? null}
              onSize={(s) => setSize(b.key, s)}
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
