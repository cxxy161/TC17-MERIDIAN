import React, { useMemo } from 'react';
import { useGameStore } from '../store/useGameStore';
import { DocView } from '../docs/DocView';
import type { PaneProps } from '../layout/paneRegistry';

/**
 * 游戏内窗口外壳。数据与独立网页（/docs/）完全共用 DocView + apiDocs，
 * 这里只负责把 PaneParams.docId 变成导航、把当前 catalog 变成 RESOURCE_* 清单。
 */
export const ApiDocsPanel: React.FC<PaneProps> = ({ params, setParams }) => {
  const catalog = useGameStore((s) => s.catalog);
  const items = useMemo(
    () => (catalog?.items ?? []).map((it) => ({ id: it.id, name: it.name })),
    [catalog],
  );

  return (
    <div className="h-full overflow-hidden bg-[#1e242d] text-slate-200">
      <DocView
        variant="pane"
        docId={params.docId}
        items={items}
        catalog={catalog}
        onNavigate={(id) => setParams({ docId: id })}
      />
    </div>
  );
};

export default ApiDocsPanel;
