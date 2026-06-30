import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Folder, FolderOpen, ChevronRight, Film } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from './ui/dialog';
import { Button } from './ui/button';
import { videosApi } from '@/api/videos';
import { cn } from '@/lib/utils';
import type { FolderTree } from '@/types';

interface MoveModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  excludeFolder?: string;
  onConfirm: (destFolder: string) => Promise<void>;
}

function PickerNode({ node, depth, selected, onSelect, exclude }: {
  node: FolderTree; depth: number; selected: string;
  onSelect: (p: string) => void; exclude?: string;
}) {
  const [open, setOpen] = useState(depth <= 1);
  if (exclude && (node.path === exclude || node.path.startsWith(exclude + '/'))) return null;
  const visibleChildren = node.children.filter(
    c => !exclude || (c.path !== exclude && !c.path.startsWith(exclude + '/')),
  );
  const hasChildren = visibleChildren.length > 0;

  return (
    <div>
      <button
        onClick={() => { onSelect(node.path); if (hasChildren) setOpen(o => !o); }}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors',
          node.path === selected
            ? 'bg-accent-light text-accent-hover font-medium'
            : 'text-text-muted hover:text-text-primary hover:bg-elevated',
        )}
        style={{ paddingLeft: `${(depth + 1) * 12}px` }}
      >
        {hasChildren
          ? <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')} />
          : <span className="h-3 w-3 shrink-0" />}
        {node.path === ''
          ? <Film className="h-3.5 w-3.5 shrink-0" />
          : open && hasChildren
          ? <FolderOpen className="h-3.5 w-3.5 shrink-0" />
          : <Folder className="h-3.5 w-3.5 shrink-0" />}
        <span className="truncate">{node.path === '' ? 'Root' : node.name}</span>
      </button>
      {open && hasChildren && (
        <div>
          {visibleChildren.map(child => (
            <PickerNode
              key={child.path} node={child} depth={depth + 1}
              selected={selected} onSelect={onSelect} exclude={exclude}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function MoveModal({ open, onClose, title, excludeFolder, onConfirm }: MoveModalProps) {
  const [dest, setDest] = useState('');
  const [busy, setBusy] = useState(false);
  const { data: tree } = useQuery({ queryKey: ['tree'], queryFn: videosApi.tree });

  const submit = async () => {
    setBusy(true);
    try { await onConfirm(dest); onClose(); } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Move to…</DialogTitle></DialogHeader>
        <DialogBody className="space-y-4">
          <p className="truncate text-xs text-text-muted">
            Moving: <span className="font-medium text-text-primary">{title}</span>
          </p>
          <div className="max-h-64 overflow-y-auto rounded-xl border border-border bg-surface p-2">
            {tree ? (
              <PickerNode node={tree} depth={0} selected={dest} onSelect={setDest} exclude={excludeFolder} />
            ) : (
              <div className="space-y-1">
                {[1, 2, 3].map(i => <div key={i} className="h-8 animate-pulse rounded-lg bg-elevated" />)}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={submit} disabled={busy}>Move here</Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
