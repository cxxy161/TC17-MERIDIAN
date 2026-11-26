import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BookOpen, Home, Printer } from 'lucide-react';
import { DocView } from './DocView';
import { DEFAULT_DOC_ID, DOC_VERSION, docTitle } from './apiDocs';
import type { ProductionPack } from '../types/meridian';

function readHash(): string | undefined {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export const DocsPage: React.FC = () => {
  const [docId, setDocId] = useState<string | undefined>(() => readHash());
  const [catalog, setCatalog] = useState<ProductionPack | null>(null);

  useEffect(() => {
    const onHash = () => setDocId(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    let alive = true;
    fetch('/api/catalog')
      .then((res) => (res.ok ? (res.json() as Promise<ProductionPack>) : null))
      .then((pack) => {
        if (!alive || !pack || !Array.isArray(pack.items)) return;
        setCatalog(pack);
      })
      .catch(() => {
        /* 静态清单仍可通过常量条目基础部分展示，动态芯片无数据时优雅降级 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const items = useMemo(
    () => (catalog?.items ?? []).map((it) => ({ id: it.id, name: it.name })),
    [catalog],
  );

  useEffect(() => {
    document.title = docTitle(docId) + ' · Meridian 脚本 API';
  }, [docId]);

  const navigate = useCallback((id: string) => {
    setDocId(id);
    const nextHash = '#' + encodeURIComponent(id);
    if (window.location.hash !== nextHash) {
      window.history.pushState(null, '', nextHash);
    }
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#161b22] text-slate-200">
      <header className="docs-chrome flex h-11 shrink-0 items-center gap-3 border-b border-[rgba(56,189,248,0.14)] bg-[#232a36] px-4">
        <a
          href="/"
          className="inline-flex items-center gap-1 rounded-[2px] border border-slate-600/70 bg-[#181e27] px-2 py-[3px] text-[11px] text-slate-300 hover:border-sky-400/60 hover:text-sky-200"
          title="返回游戏工作台"
        >
          <ArrowLeft size={12} />
          返回游戏
        </a>
        <div className="flex items-center gap-2">
          <BookOpen size={14} className="text-sky-400" />
          <span className="text-[13px] font-medium tracking-wide text-slate-100">
            Meridian 脚本 API 参考
          </span>
          <span className="mono hidden rounded-[2px] border border-sky-400/30 bg-sky-500/10 px-1.5 py-[1px] text-[9.5px] text-sky-300 sm:inline">
            {DOC_VERSION}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => navigate(DEFAULT_DOC_ID)}
            className="inline-flex items-center gap-1 rounded-[2px] border border-slate-600/70 bg-[#181e27] px-2 py-[3px] text-[10.5px] text-slate-300 hover:border-sky-400/60 hover:text-sky-200"
            title="回到 API 总览首页"
          >
            <Home size={11} />
            API 总览
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1 rounded-[2px] border border-slate-600/70 bg-[#181e27] px-2 py-[3px] text-[10.5px] text-slate-300 hover:border-sky-400/60 hover:text-sky-200"
            title="打印或另存为 PDF"
          >
            <Printer size={11} />
            打印 / PDF
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1">
        <DocView variant="page" docId={docId} onNavigate={navigate} items={items} catalog={catalog} />
      </div>
    </div>
  );
};
