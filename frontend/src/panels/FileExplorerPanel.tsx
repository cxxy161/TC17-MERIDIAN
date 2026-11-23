import React, { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Edit2,
  FileCode2,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Trash2,
} from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import type { PaneProps } from '../layout/paneRegistry';

interface TreeFolder {
  kind: 'folder';
  name: string;
  path: string;
  children: TreeItem[];
}

interface TreeFile {
  kind: 'file';
  name: string;
  path: string;
}

type TreeItem = TreeFolder | TreeFile;

function buildFileTree(moduleNames: string[], explicitFolders: string[]): TreeItem[] {
  const root: TreeFolder = { kind: 'folder', name: '', path: '', children: [] };

  const ensureFolder = (folderPath: string): TreeFolder => {
    if (!folderPath) return root;
    const parts = folderPath.split('/').filter(Boolean);
    let cur = root;
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      let existing = cur.children.find(
        (c): c is TreeFolder => c.kind === 'folder' && c.name === part,
      );
      if (!existing) {
        existing = { kind: 'folder', name: part, path: acc, children: [] };
        cur.children.push(existing);
      }
      cur = existing;
    }
    return cur;
  };

  for (const f of explicitFolders) {
    ensureFolder(f);
  }

  for (const mod of moduleNames) {
    const parts = mod.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    const fileName = parts[parts.length - 1];
    const dirPath = parts.slice(0, -1).join('/');
    const parent = ensureFolder(dirPath);
    if (!parent.children.some((c) => c.kind === 'file' && c.path === mod)) {
      parent.children.push({ kind: 'file', name: fileName, path: mod });
    }
  }

  const sortTree = (folder: TreeFolder) => {
    folder.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const c of folder.children) {
      if (c.kind === 'folder') sortTree(c);
    }
  };
  sortTree(root);

  return root.children;
}

export const FileExplorerPanel: React.FC<PaneProps> = ({ openTemp }) => {
  const draftModules = useGameStore((s) => s.draftModules);
  const scripts = useGameStore((s) => s.scripts);
  const activeMod = useGameStore((s) => s.activeScriptModule);
  const scriptDirty = useGameStore((s) => s.scriptDirty);
  const scriptFolders = useGameStore((s) => s.scriptFolders);
  const setActiveMod = useGameStore((s) => s.setActiveScriptModule);
  const createDraftModule = useGameStore((s) => s.createDraftModule);
  const renameDraftModule = useGameStore((s) => s.renameDraftModule);
  const deleteDraftModule = useGameStore((s) => s.deleteDraftModule);
  const createScriptFolder = useGameStore((s) => s.createScriptFolder);
  const renameScriptFolder = useGameStore((s) => s.renameScriptFolder);
  const deleteScriptFolder = useGameStore((s) => s.deleteScriptFolder);
  const saveDraftScripts = useGameStore((s) => s.saveDraftScripts);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selectedFolder, setSelectedFolder] = useState<string>('');
  const [creating, setCreating] = useState<{ mode: 'file' | 'folder'; parent: string } | null>(null);
  const [createValue, setCreateValue] = useState('');
  const [renaming, setRenaming] = useState<{ kind: 'file' | 'folder'; path: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<{ kind: 'file' | 'folder'; path: string } | null>(null);

  const modNames = useMemo(() => {
    const src = Object.keys(draftModules).length > 0 ? draftModules : (scripts?.modules ?? { main: '' });
    return Object.keys(src);
  }, [draftModules, scripts]);

  const tree = useMemo(
    () => buildFileTree(modNames, scriptFolders),
    [modNames, scriptFolders],
  );

  const isExpanded = (path: string) => expanded[path] ?? true;

  const submitCreate = () => {
    const clean = createValue.trim().replace(/^\/+|\/+$/g, '');
    if (clean && creating) {
      const fullPath = creating.parent ? `${creating.parent}/${clean}` : clean;
      if (creating.mode === 'folder') {
        createScriptFolder(fullPath);
        setExpanded((prev) => ({ ...prev, [fullPath]: true }));
      } else {
        createDraftModule(fullPath);
      }
      if (creating.parent) {
        setExpanded((prev) => ({ ...prev, [creating.parent]: true }));
      }
    }
    setCreating(null);
    setCreateValue('');
  };

  const submitRename = () => {
    const clean = renameValue.trim().replace(/^\/+|\/+$/g, '').replace(/\.js$/, '');
    if (clean && renaming) {
      const parts = renaming.path.split('/');
      parts[parts.length - 1] = clean;
      const newPath = parts.join('/');
      if (renaming.kind === 'file') {
        renameDraftModule(renaming.path, newPath);
      } else {
        renameScriptFolder(renaming.path, newPath);
      }
    }
    setRenaming(null);
    setRenameValue('');
  };

  const renderItems = (items: TreeItem[], depth: number): React.ReactNode =>
    items.map((item) => {
      const isRenamingThis = renaming?.kind === item.kind && renaming.path === item.path;
      const isDeletingThis = confirmDelete?.kind === item.kind && confirmDelete.path === item.path;

      if (item.kind === 'folder') {
        const open = isExpanded(item.path);
        const isSel = selectedFolder === item.path;
        return (
          <div key={`folder:${item.path}`}>
            <div
              onClick={() => {
                setSelectedFolder(item.path);
                setExpanded((prev) => ({ ...prev, [item.path]: !open }));
              }}
              style={{ paddingLeft: 6 + depth * 14 }}
              className={`group flex items-center justify-between pr-2 py-1 text-[11px] cursor-pointer hover:bg-sky-500/10 ${
                isSel ? 'bg-sky-500/10 text-sky-200' : 'text-slate-300'
              }`}
            >
              <div className="flex items-center gap-1.5 min-w-0 flex-1">
                {open ? (
                  <ChevronDown className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                )}
                {open ? (
                  <FolderOpen className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                ) : (
                  <Folder className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                )}
                {isRenamingThis ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitRename();
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                    className="w-28 bg-[#191f27] border border-sky-400 px-1 text-[11px] outline-none"
                  />
                ) : (
                  <span className="truncate">{item.name}</span>
                )}
              </div>

              <div
                className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  onClick={() => {
                    setCreating({ mode: 'file', parent: item.path });
                    setCreateValue('');
                  }}
                  title="在此文件夹新建文件"
                  className="p-0.5 text-slate-400 hover:text-sky-300"
                >
                  <FilePlus className="w-3 h-3" />
                </button>
                <button
                  onClick={() => {
                    setCreating({ mode: 'folder', parent: item.path });
                    setCreateValue('');
                  }}
                  title="新建子文件夹"
                  className="p-0.5 text-slate-400 hover:text-sky-300"
                >
                  <FolderPlus className="w-3 h-3" />
                </button>
                <button
                  onClick={() => {
                    setRenaming({ kind: 'folder', path: item.path });
                    setRenameValue(item.name);
                  }}
                  title="重命名文件夹"
                  className="p-0.5 text-slate-400 hover:text-white"
                >
                  <Edit2 className="w-3 h-3" />
                </button>
                <button
                  onClick={() => setConfirmDelete({ kind: 'folder', path: item.path })}
                  title="删除文件夹"
                  className="p-0.5 text-slate-400 hover:text-rose-400"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>

            {isDeletingThis && (
              <div
                style={{ paddingLeft: 20 + depth * 14 }}
                className="flex items-center gap-2 py-1 pr-2 bg-rose-500/15 text-[10px]"
              >
                <span className="text-rose-300">删除文件夹及内部文件？</span>
                <button
                  onClick={() => {
                    deleteScriptFolder(item.path);
                    setConfirmDelete(null);
                  }}
                  className="text-rose-300 underline font-semibold"
                >
                  确定
                </button>
                <button onClick={() => setConfirmDelete(null)} className="text-slate-400">
                  取消
                </button>
              </div>
            )}

            {open && renderItems(item.children, depth + 1)}
          </div>
        );
      }

      const isActive = activeMod === item.path;
      return (
        <div key={`file:${item.path}`}>
          <div
            onClick={() => {
              setActiveMod(item.path);
              const dir = item.path.includes('/') ? item.path.split('/').slice(0, -1).join('/') : '';
              setSelectedFolder(dir);
            }}
            style={{ paddingLeft: 10 + depth * 14 }}
            className={`group flex items-center justify-between pr-2 py-1 text-[11px] cursor-pointer ${
              isActive
                ? 'bg-sky-500/20 text-sky-200 border-l-2 border-sky-400'
                : 'text-slate-300 hover:bg-sky-500/10'
            }`}
          >
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <FileCode2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              {isRenamingThis ? (
                <input
                  autoFocus
                  value={renameValue}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitRename();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  className="w-28 bg-[#191f27] border border-sky-400 px-1 text-[11px] mono outline-none"
                />
              ) : (
                <span className="mono truncate">{item.name}.js</span>
              )}
            </div>

            {item.path !== 'main' && (
              <div
                className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  onClick={() => {
                    setRenaming({ kind: 'file', path: item.path });
                    setRenameValue(item.name);
                  }}
                  title="重命名文件"
                  className="p-0.5 text-slate-400 hover:text-white"
                >
                  <Edit2 className="w-3 h-3" />
                </button>
                <button
                  onClick={() => setConfirmDelete({ kind: 'file', path: item.path })}
                  title="删除文件"
                  className="p-0.5 text-slate-400 hover:text-rose-400"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>

          {isDeletingThis && (
            <div
              style={{ paddingLeft: 20 + depth * 14 }}
              className="flex items-center gap-2 py-1 pr-2 bg-rose-500/15 text-[10px]"
            >
              <span className="text-rose-300">删除 {item.name}.js？</span>
              <button
                onClick={() => {
                  deleteDraftModule(item.path);
                  setConfirmDelete(null);
                }}
                className="text-rose-300 underline font-semibold"
              >
                确定
              </button>
              <button onClick={() => setConfirmDelete(null)} className="text-slate-400">
                取消
              </button>
            </div>
          )}
        </div>
      );
    });

  return (
    <div className="h-full flex flex-col bg-[#202732] text-slate-200 overflow-hidden select-none">
      {/* VSC Explorer Header Toolbar */}
      <div className="px-2.5 py-1.5 border-b border-sky-500/15 bg-[#232a36] flex items-center justify-between gap-1 shrink-0">
        <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">
          策略代码工作区
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              setCreating({ mode: 'file', parent: selectedFolder });
              setCreateValue('');
            }}
            title="新建代码文件"
            className="p-1 text-slate-300 hover:text-sky-300 hover:bg-sky-500/15 rounded-sm"
          >
            <FilePlus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => {
              setCreating({ mode: 'folder', parent: selectedFolder });
              setCreateValue('');
            }}
            title="新建文件夹"
            className="p-1 text-slate-300 hover:text-sky-300 hover:bg-sky-500/15 rounded-sm"
          >
            <FolderPlus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => openTemp('script', {})}
            title="打开悬浮编辑器"
            className="pill-btn py-0 text-[10px]"
          >
            编辑器
          </button>
        </div>
      </div>

      {/* Inline Creation Bar (zero alert/prompt!) */}
      {creating && (
        <div className="px-2.5 py-1.5 border-b border-sky-500/20 bg-[#1b212b] flex items-center gap-1.5">
          <span className="text-[10px] text-sky-300 shrink-0">
            {creating.mode === 'folder' ? '新文件夹:' : '新文件:'}
            {creating.parent ? ` ${creating.parent}/` : ''}
          </span>
          <input
            autoFocus
            value={createValue}
            onChange={(e) => setCreateValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitCreate();
              if (e.key === 'Escape') setCreating(null);
            }}
            placeholder={creating.mode === 'folder' ? '例如 market' : '例如 hauler'}
            className="flex-1 min-w-0 bg-[#191f27] border border-sky-400/60 px-1.5 py-0.5 text-[11px] mono outline-none rounded-sm"
          />
          <button onClick={submitCreate} className="cta-blue py-0 px-1.5 text-[10px]">
            确定
          </button>
        </div>
      )}

      {/* Tree */}
      <div
        className="flex-1 overflow-y-auto py-1 bg-[#1b212b]"
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelectedFolder('');
        }}
      >
        {renderItems(tree, 0)}
      </div>

      {/* Bottom Dirty Status */}
      <div className="px-2.5 py-1.5 border-t border-sky-500/15 bg-[#232a36] flex items-center justify-between text-[10px]">
        <span className="text-slate-400 mono truncate">require('{activeMod}')</span>
        {scriptDirty && (
          <button onClick={() => void saveDraftScripts()} className="cta-green py-0 px-2 text-[10px]">
            热重载保存
          </button>
        )}
      </div>
    </div>
  );
};
