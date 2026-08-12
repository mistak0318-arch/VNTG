import { useState } from "react";

export function RawJson({ data }: { data: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button className="raw-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? "원본 JSON 숨기기" : "원본 JSON 보기 (필드명 확인용)"}
      </button>
      {open && <pre className="raw-json">{JSON.stringify(data, null, 2)}</pre>}
    </div>
  );
}
