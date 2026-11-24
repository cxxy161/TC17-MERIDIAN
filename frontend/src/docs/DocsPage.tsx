import React, { useCallback, useEffect, useState } from 'react';
import { BookOpen, ExternalLink } from 'lucide-react';
import { DocView } from './DocView';
import { docTitle } from './apiDocs';
import type { ProductionPack } from '../types/meridian';

/**
 * 独立文档页（/docs/）：免登录、只读、没有会话逻辑。
 * 与游戏内窗口共用 DocView，区别只在「外壳」和「导航写到哪里」——这里写 location.hash，
 * 所以 #Game.market.createOrder 可以直接分享、前进后退可用。
 */
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
  const [items, setItems] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    const onHash = () => setDocId(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // /api/catalog 无鉴权：拿到当前世界的物品表，把 RESOURCE_<ID> 清单渲染成真实常量。
  useEffect(() => {
    let alive = true;
    fetch('/api/catalog')
      .then((res) => (res.ok ? (res.json() as Promise<ProductionPack>) : null))
      .then((pack) => {
        if (!alive || !pack || !Array.isArray(pack.items)) return;
        setItems(pack.items.map((it) => ({ id: it.id, name: it.name })));
      })
      .catch(() => {
        /* 后端没起来时只显示静态文档，不打断阅读 */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    document.title = docTitle(docId) + ' · Meridian 脚本 API';
  }, [docId]);

  const navigate = useCallback((id: string) => {
    const next = '#' + encodeURIComponent(id);
    if (window.location.hash !== next) window.location.hash = next;
    setDocId(id);
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#0b1017] text-slate-200">
      <header className="docs-chrome flex h-11 shrink-0 items-center gap-3 border-b border-sky-500/20 bg-[#0e141c] px-4">
        <BookOpen size={15} className="shrink-0 text-sky-400" />
        <div className="min-w-0">
          <div className="truncate text-[12px] font-medium tracking-[0.08em] text-slate-100">
            子午线 · 脚本 API 参考
          </div>
          <div className="mono truncate text-[9px] text-slate-500">
            Game · Memory · console · require · Store
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-3 text-[10px]">
          <span className="hidden text-slate-500 sm:inline">只读文档 · 无需登录</span>
          <a
            href="/"
            className="inline-flex items-center gap-1 rounded-[2px] border border-sky-500/35 bg-sky-500/[0.08] px-2 py-1 text-sky-200 transition-colors hover:border-sky-400/70 hover:bg-sky-500/15 hover:text-sky-100"
          >
            进入游戏
            <ExternalLink size={10} />
          </a>
        </div>
      </header>

      <div className="min-h-0 flex-1">
        <DocView variant="page" docId={docId} onNavigate={navigate} items={items} />
      </div>
    </div>
  );
};

export default DocsPage;
