import { useEffect, useMemo, useState } from "react";
import { api, type ChannelEntry, type ChannelReport } from "../api";

/**
 * 구독 채널 수집 설정.
 *
 * 180개를 전부 켜면 안 된다 — 광고 채널과 잡담방이 섞여 있고, 그걸 AI에 넣으면
 * 비용만 늘고 요약은 나빠진다. 그래서 기본은 전부 꺼진 상태이고 여기서 골라 켠다.
 *
 * "AI 없이 선별만"이 중요하다. 필터가 제대로 도는지를 **비용 없이** 확인한 다음
 * AI를 붙여야, 프롬프트를 고칠 때마다 돈이 나가지 않는다.
 */

function fmtWhen(iso: string | null): string {
  if (!iso) return "활동 없음";
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400_000);
  if (days === 0) return "오늘";
  if (days === 1) return "어제";
  if (days < 30) return `${days}일 전`;
  return d.toISOString().slice(0, 10);
}

type SortKey = "members" | "recent" | "name";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "members", label: "구독자순" },
  { key: "recent", label: "최근 활동순" },
  { key: "name", label: "이름순" },
];

export function ChannelCollectPanel() {
  const [configured, setConfigured] = useState(true);
  const [channels, setChannels] = useState<ChannelEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [onlyOn, setOnlyOn] = useState(false);
  const [sort, setSort] = useState<SortKey>("members");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [report, setReport] = useState<ChannelReport | null>(null);

  async function load() {
    try {
      const r = await api.channels();
      setConfigured(r.configured);
      setChannels(r.channels);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "불러오기 실패");
    }
  }

  useEffect(() => {
    load();
  }, []);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rows = channels.filter((c) => {
      if (onlyOn && !c.enabled) return false;
      if (!q) return true;
      return c.name.toLowerCase().includes(q) || (c.username ?? "").toLowerCase().includes(q);
    });

    // 구독자 수를 모르는 채널(비공개 등)은 0으로 보고 뒤로 보낸다
    const members = (c: ChannelEntry) => c.participants ?? 0;

    return [...rows].sort((a, b) => {
      if (sort === "members") return members(b) - members(a) || a.name.localeCompare(b.name, "ko");
      if (sort === "recent") return (b.lastAt ?? "").localeCompare(a.lastAt ?? "");
      return a.name.localeCompare(b.name, "ko");
    });
  }, [channels, filter, onlyOn, sort]);

  const onCount = channels.filter((c) => c.enabled).length;

  async function toggle(id: string, enabled: boolean) {
    setChannels((prev) => prev.map((c) => (c.id === id ? { ...c, enabled } : c)));
    try {
      await api.channelsSetEnabled([{ id, enabled }]);
    } catch {
      load(); // 실패하면 서버 상태로 되돌린다
    }
  }

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setNote(null);
    try {
      await fn();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "실패");
    } finally {
      setBusy(null);
    }
  }

  if (!configured) {
    return (
      <div className="page-note">
        <b>텔레그램 사용자 세션이 설정되지 않았습니다.</b>
        <br />
        봇 API로는 내가 구독 중인 채널을 읽을 수 없어(봇은 초대된 방만 봅니다) 사용자 계정
        로그인이 따로 필요합니다.
        <br />
        <br />
        1. <code>https://my.telegram.org</code> → API development tools 에서 api_id / api_hash 발급
        <br />
        2. <code>server/.env</code> 에 <code>TELEGRAM_API_ID</code>,{" "}
        <code>TELEGRAM_API_HASH</code> 입력
        <br />
        3. <code>cd server &amp;&amp; node scripts/telegram-login.mjs</code> 실행 후 안내대로 입력
        <br />
        4. 출력된 <code>TELEGRAM_SESSION</code> 을 .env 에 넣고 서버 재시작
        <br />
        <br />
        ⚠ <b>세션은 한 대에서만 써야 합니다.</b> 두 대에서 동시에 접속하면 세션이 무효화되므로,
        최종 운영 기기(미니PC)에서 로그인하세요.
      </div>
    );
  }

  return (
    <div className="sig-config">
      <div className="sig-config-actions" style={{ marginTop: 0 }}>
        <button
          className="filter-btn"
          disabled={busy !== null}
          onClick={() =>
            run("refresh", async () => {
              const r = await api.channelsRefresh();
              setChannels(r.channels);
              setNote(`구독 목록 ${r.channels.length}개를 다시 읽었습니다.`);
            })
          }
        >
          {busy === "refresh" ? "읽는 중…" : "↻ 구독 목록 새로고침"}
        </button>
        <button
          className="filter-btn"
          disabled={busy !== null || onCount === 0}
          onClick={() =>
            run("preview", async () => {
              const r = await api.channelsReport({ ai: false });
              setReport(r);
              setNote(
                `원본 ${r.rawCount}건 → 선별 ${r.usedCount}건 (AI 미호출 · 비용 없음)` +
                  (r.skipped.length > 0 ? ` · 건너뛴 채널 ${r.skipped.length}개` : ""),
              );
            })
          }
        >
          {busy === "preview" ? "수집 중…" : "선별만 보기 (AI 미사용)"}
        </button>
        <button
          className="primary-btn"
          disabled={busy !== null || onCount === 0}
          onClick={() =>
            run("ai", async () => {
              const r = await api.channelsReport({ ai: true });
              setReport(r);
              setNote(
                `정리 완료 · 토큰 ${r.inputTokens}/${r.outputTokens}` +
                  (r.error ? ` · ${r.error}` : ""),
              );
            })
          }
        >
          {busy === "ai" ? "정리 중…" : "AI로 정리"}
        </button>
        <button
          className="filter-btn"
          disabled={busy !== null || !report?.summary}
          onClick={() =>
            run("send", async () => {
              const r = await api.channelsReport({ ai: true, send: true });
              setReport(r);
              setNote("채널요약 방으로 발송했습니다.");
            })
          }
        >
          정리 후 발송
        </button>
      </div>

      {note && <div className="alert-note">{note}</div>}

      <div className="filter-row" style={{ marginTop: 12 }}>
        <input
          className="search-input"
          style={{ maxWidth: 220 }}
          placeholder="채널 이름 검색"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          className={`filter-btn ${onlyOn ? "active" : ""}`}
          onClick={() => setOnlyOn((v) => !v)}
        >
          켠 것만
        </button>
        <span className="news-scope-sep" />
        {SORTS.map((s) => (
          <button
            key={s.key}
            className={`filter-btn ${sort === s.key ? "active" : ""}`}
            onClick={() => setSort(s.key)}
          >
            {s.label}
          </button>
        ))}
        <span className="breadth-count">
          수집 {onCount} / 전체 {channels.length}
        </span>
      </div>

      {channels.length === 0 ? (
        <div className="page-note">
          아직 목록이 없습니다. <b>구독 목록 새로고침</b>을 눌러 텔레그램에서 가져오세요.
        </div>
      ) : (
        <div className="chan-list">
          {shown.slice(0, 200).map((c) => (
            <label className={`chan-row${c.enabled ? " on" : ""}`} key={c.id}>
              <input
                type="checkbox"
                checked={c.enabled}
                onChange={(e) => toggle(c.id, e.target.checked)}
              />
              <span className="chan-name">{c.name}</span>
              <span className="chan-meta">
                {c.broadcast ? "채널" : "그룹"}
                {c.participants ? ` · ${c.participants.toLocaleString("ko-KR")}명` : ""}
                {` · ${fmtWhen(c.lastAt)}`}
              </span>
            </label>
          ))}
          {shown.length > 200 && (
            <div className="table-note">…{shown.length - 200}개 더 (검색으로 좁히세요)</div>
          )}
        </div>
      )}

      {report && report.items.length > 0 && (
        <>
          <h3 className="section-heading">선별 결과 상위 {Math.min(report.items.length, 15)}건</h3>
          <div className="chan-items">
            {report.items.slice(0, 15).map((it, i) => (
              <div className="chan-item" key={i}>
                <div className="chan-item-head">
                  {it.coverage > 1 && <span className="news-tag hot">{it.coverage}개 채널</span>}
                  {it.mentions.length > 0 && (
                    <span className="news-tag watch">★ {it.mentions.join(", ")}</span>
                  )}
                  <span className="chan-item-time">{it.at.slice(11, 16)}</span>
                </div>
                <div className="chan-item-text">{it.text}</div>
                <div className="chan-item-src">{it.channels.join(" · ")}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {report?.summary && (
        <>
          <h3 className="section-heading">AI 정리</h3>
          <pre className="alert-preview">{report.summary}</pre>
        </>
      )}

      <div className="table-note">
        처음 발견된 채널은 <b>꺼진 상태</b>로 들어옵니다 — 180개가 한꺼번에 켜지면 비용과 품질이
        모두 나빠집니다. 시황·종목 이야기가 실제로 오가는 채널만 켜세요. 같은 내용을 여러 채널이
        퍼나르면 하나로 묶고 <b>몇 개 채널이 다뤘는지</b>를 점수로 씁니다.
      </div>
    </div>
  );
}
