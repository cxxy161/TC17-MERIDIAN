import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import type { PaneProps } from '../layout/paneRegistry';

const JsonNode: React.FC<{
  name: string;
  value: unknown;
  depth: number;
  filter: string;
}> = ({ name, value, depth, filter }) => {
  const [open, setOpen] = useState(depth < 2);
  const isObj = value !== null && typeof value === 'object';
  const entries = isObj ? Object.entries(value as Record<string, unknown>) : [];
  const isArray = Array.isArray(value);

  if (
    filter &&
    !name.toLowerCase().includes(filter) &&
    !JSON.stringify(value).toLowerCase().includes(filter)
  ) {
    return null;
  }

  if (!isObj) {
    const color =
      typeof value === 'string'
        ? 'text-emerald-300'
        : typeof value === 'number'
          ? 'text-sky-300'
          : typeof value === 'boolean'
            ? 'text-amber-300'
            : 'text-slate-500';
    return (
      <div
        style={{ paddingLeft: depth * 14 }}
        className="flex items-baseline gap-1.5 py-0.5 hover:bg-sky-500/5 mono text-[11px]"
      >
        <span className="text-slate-400">{name}:</span>
        <span className={`${color} break-all`}>{JSON.stringify(value)}</span>
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ paddingLeft: depth * 14 }}
        className="w-full text-left flex items-center gap-1 py-0.5 hover:bg-sky-500/10 mono text-[11px]"
      >
        {open ? (
          <ChevronDown className="w-3 h-3 text-slate-500 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-slate-500 shrink-0" />
        )}
        <span className="text-sky-200">{name}</span>
        <span className="text-slate-500 text-[10px]">
          {isArray ? `[${entries.length}]` : `{${entries.length}}`}
        </span>
      </button>
      {open &&
        entries.map(([k, v]) => (
          <JsonNode key={k} name={k} value={v} depth={depth + 1} filter={filter} />
        ))}
    </div>
  );
};

export const MemoryPanel: React.FC<PaneProps> = () => {
  const scripts = useGameStore((s) => s.scripts);
  const saveMemory = useGameStore((s) => s.saveMemory);

  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState('{}');
  const [filter, setFilter] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);

  const rawJson = scripts?.memory_json ?? '{}';

  useEffect(() => {
    if (!editMode) {
      setDraft(rawJson);
    }
  }, [rawJson, editMode]);

  const parsed = useMemo(() => {
    try {
      return JSON.parse(rawJson) as Record<string, unknown>;
    } catch {
      return {};
    }
  }, [rawJson]);

  const sizeKb = (new Blob([rawJson]).size / 1024).toFixed(2);

  const handleSave = async () => {
    try {
      JSON.parse(draft);
      setJsonError(null);
      await saveMemory(draft);
      setEditMode(false);
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : 'JSON 格式无效');
    }
  };

  return (
    <div className="h-full flex flex-col bg-[#202732] text-slate-200 overflow-hidden">
      <div className="px-2.5 py-1.5 border-b border-sky-500/15 bg-[#232a36] flex items-center justify-between gap-2 shrink-0">
        <span className="mono text-[10px] text-emerald-400">
          占用 {sizeKb} / 128.00 KB
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => {
              try {
                setDraft(JSON.stringify(JSON.parse(rawJson), null, 2));
              } catch {
                setDraft(rawJson);
              }
              setJsonError(null);
              setEditMode((v) => !v);
            }}
            className={`pill-btn py-0 text-[10px] ${editMode ? 'active' : ''}`}
          >
            {editMode ? '树形查看' : '编辑 JSON'}
          </button>
          {editMode && (
            <button onClick={() => void handleSave()} className="cta-green py-0 px-2 text-[10px]">
              写入保存
            </button>
          )}
        </div>
      </div>

      {!editMode ? (
        <>
          <div className="px-2.5 py-1.5 border-b border-slate-700/60 bg-[#1b212b] flex items-center gap-1.5">
            <Search className="w-3 h-3 text-slate-500 shrink-0" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="过滤键名或值..."
              className="flex-1 bg-transparent outline-none text-[11px] text-slate-200 placeholder:text-slate-600"
            />
          </div>
          <div className="flex-1 overflow-y-auto p-2.5 bg-[#191f27]">
            <JsonNode name="Memory" value={parsed} depth={0} filter={filter.trim().toLowerCase()} />
          </div>
        </>
      ) : (
        <div className="flex-1 flex flex-col p-2.5 gap-2 min-h-0 bg-[#191f27]">
          {jsonError && (
            <div className="text-[11px] text-rose-400 mono">解析失败：{jsonError}</div>
          )}
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="flex-1 bg-[#1b212b] border border-slate-700 p-2.5 mono text-[11px] text-emerald-300 outline-none resize-none rounded-sm"
          />
        </div>
      )}
    </div>
  );
};
