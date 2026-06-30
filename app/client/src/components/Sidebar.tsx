import { useState, useRef, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Folder, FolderOpen, ChevronRight, Film, Plus, Pencil, Trash2, Move } from 'lucide-react';
import { videosApi } from '@/api/videos';
import { cn } from '@/lib/utils';
import type { FolderTree } from '@/types';

const MIN_WIDTH = 150;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 208;

interface SidebarProps {
  selected: string;
  onSelect: (folder: string) => void;
  onCreateFolder: (parent: string) => void;
  onRenameFolder: (folder: string) => void;
  onDeleteFolder: (folder: string) => void;
  onMoveFolder: (folder: string) => void;
}

interface TreeNodeProps {
  node: FolderTree;
  depth: number;
  selected: string;
  onSelect: (folder: string) => void;
  onCreateFolder: (parent: string) => void;
  onRenameFolder: (folder: string) => void;
  onDeleteFolder: (folder: string) => void;
  onMoveFolder: (folder: string) => void;
}

function TreeNode({ node, depth, selected, onSelect, onCreateFolder, onRenameFolder, onDeleteFolder, onMoveFolder }: TreeNodeProps) {
  const [open, setOpen] = useState(depth === 0);
  const isRoot = node.path === '';
  const isSelected = node.path === selected;
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div className="group/node relative flex items-center">
        <button
          onClick={() => { onSelect(node.path); if (hasChildren) setOpen(o => !o); }}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pr-1 text-left text-sm transition-colors',
            isSelected
              ? 'bg-accent-light text-accent-hover font-medium'
              : 'text-text-muted hover:text-text-primary hover:bg-elevated',
          )}
          style={{ paddingLeft: `${(depth + 1) * 12}px` }}
        >
          {hasChildren ? (
            <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')} />
          ) : (
            <span className="h-3 w-3 shrink-0" />
          )}
          {isRoot ? (
            <Film className="h-3.5 w-3.5 shrink-0" />
          ) : open && hasChildren ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="flex-1 truncate">{isRoot ? 'All folders' : node.name}</span>
          <span className="shrink-0 text-xs text-text-subtle">{node.totalCount}</span>
        </button>

        {/* Hover actions */}
        <div className="absolute right-0.5 hidden items-center rounded-md bg-surface group-hover/node:flex">
          <button
            onClick={e => { e.stopPropagation(); onCreateFolder(node.path); }}
            title="New subfolder"
            className="rounded p-1 text-text-subtle hover:bg-elevated hover:text-text-primary"
          >
            <Plus className="h-3 w-3" />
          </button>
          {!isRoot && (
            <>
              <button
                onClick={e => { e.stopPropagation(); onRenameFolder(node.path); }}
                title="Rename"
                className="rounded p-1 text-text-subtle hover:bg-elevated hover:text-text-primary"
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                onClick={e => { e.stopPropagation(); onMoveFolder(node.path); }}
                title="Move"
                className="rounded p-1 text-text-subtle hover:bg-elevated hover:text-text-primary"
              >
                <Move className="h-3 w-3" />
              </button>
              <button
                onClick={e => { e.stopPropagation(); onDeleteFolder(node.path); }}
                title="Delete"
                className="rounded p-1 text-text-subtle hover:bg-danger/10 hover:text-danger"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </>
          )}
        </div>
      </div>

      {open && hasChildren && (
        <div>
          {node.children.map(child => (
            <TreeNode
              key={child.path} node={child} depth={depth + 1}
              selected={selected} onSelect={onSelect}
              onCreateFolder={onCreateFolder} onRenameFolder={onRenameFolder}
              onDeleteFolder={onDeleteFolder} onMoveFolder={onMoveFolder}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar({ selected, onSelect, onCreateFolder, onRenameFolder, onDeleteFolder, onMoveFolder }: SidebarProps) {
  const { data: tree } = useQuery({ queryKey: ['tree'], queryFn: videosApi.tree });

  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem('sidebar-width');
    return saved ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Number(saved))) : DEFAULT_WIDTH;
  });
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onMouseMove = useCallback((e: MouseEvent) => {
    if (!dragging.current) return;
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + e.clientX - startX.current));
    setWidth(next);
  }, []);

  const onMouseUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    setWidth(w => { localStorage.setItem('sidebar-width', String(w)); return w; });
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); };
  }, [onMouseMove, onMouseUp]);

  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <aside
      className="relative hidden shrink-0 flex-col overflow-y-auto border-r border-border lg:flex"
      style={{ width }}
    >
      <div className="p-3">
        <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wider text-text-subtle">Library</p>
        {tree ? (
          <TreeNode
            node={tree} depth={0} selected={selected} onSelect={onSelect}
            onCreateFolder={onCreateFolder} onRenameFolder={onRenameFolder}
            onDeleteFolder={onDeleteFolder} onMoveFolder={onMoveFolder}
          />
        ) : (
          <div className="space-y-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-8 animate-pulse rounded-lg bg-elevated" />
            ))}
          </div>
        )}
      </div>

      {/* Drag handle */}
      <div
        onMouseDown={onDragStart}
        className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40 active:bg-accent/60 transition-colors"
      />
    </aside>
  );
}
