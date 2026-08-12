import { useState, type ReactNode } from "react";

export function SegmentToggle<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="ov-seg">
      {options.map((o) => (
        <button key={o.key} className={o.key === value ? "on" : ""} onClick={() => onChange(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 기본 5개만 보여주고 "더보기"로 확장하는 리스트 */
export function RankList<T>({
  items,
  renderItem,
  initialCount = 5,
  emptyText = "데이터 없음",
}: {
  items: T[];
  renderItem: (item: T, index: number) => ReactNode;
  initialCount?: number;
  emptyText?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, initialCount);

  if (items.length === 0) {
    return <div className="ov-card-b ov-empty">{emptyText}</div>;
  }

  return (
    <div>
      <div className="ov-list">{visible.map((item, i) => renderItem(item, i))}</div>
      {items.length > initialCount && (
        <button className="ov-more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "접기 ‹" : `더보기 › (${items.length - initialCount})`}
        </button>
      )}
    </div>
  );
}
