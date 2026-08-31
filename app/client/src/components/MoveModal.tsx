import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Folder, FolderOpen, ChevronRight, Film, Search, FolderPlus, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { videosApi } from '@/api/videos';
import { cn } from '@/lib/utils';
import type { FolderTree } from '@/types';

interface MoveModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  excludeFolder?: string;
  /** Resolves when the move is done; the result itself is ignored. */
  onConfirm: (destFolder: string) => Promise<unknown>;
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
        {node.totalCount > 0 && (
          <span className="ml-auto shrink-0 text-xs text-text-subtle">{node.totalCount}</span>
        )}
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

/** Every folder path in the tree, for the flat search results. */
function flatten(node: FolderTree | undefined, out: FolderTree[] = []): FolderTree[] {
  if (!node) return out;
  if (node.path) out.push(node);
  for (const c of node.children) flatten(c, out);
  return out;
}

export function MoveModal({ open, onClose, title, excludeFolder, onConfirm }: MoveModalProps) {
  const qc = useQueryClient();
  const [dest, setDest] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [newFolder, setNewFolder] = useState('');
  const [creating, setCreating] = useState(false);
  const { data: tree } = useQuery({ queryKey: ['tree'], queryFn: videosApi.tree });

  // Deep libraries are unusable as a scroll-and-hunt tree, so typing filters the
  // whole path list instead of expanding branches by hand.
  const matches = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return null;
    return flatten(tree)
      .filter(n => !excludeFolder || (n.path !== excludeFolder && !n.path.startsWith(excludeFolder + '/')))
      .filter(n => n.path.toLowerCase().includes(q))
      .slice(0, 60);
  }, [filter, tree, excludeFolder]);

  const submit = async () => {
    setBusy(true);
    try { await onConfirm(dest); onClose(); } finally { setBusy(false); }
  };

  // Creating the destination from inside the dialog beats cancelling out, making
  // the folder in the sidebar, and starting the move again.
  const createHere = async () => {
    const name = newFolder.trim();
    if (!name) return;
    setCreating(true);
    try {
      const r = await videosApi.createFolder(name, dest);
      await qc.invalidateQueries({ queryKey: ['tree'] });
      setDest(r.folder);
      setNewFolder('');
      toast.success(`Created "${name}"`);
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Could not create the folder');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Move to…</DialogTitle></DialogHeader>
        <DialogBody className="space-y-3">
          <p className="truncate text-xs text-text-muted">
            Moving: <span className="font-medium text-text-primary">{title}</span>
          </p>

          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-subtle" />
            <Input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Search folders"
              className="pl-8"
              autoComplete="off"
            />
          </div>

          <div className="max-h-56 overflow-y-auto rounded-xl border border-border bg-surface p-2">
            {!tree ? (
              <div className="space-y-1">
                {[1, 2, 3].map(i => <div key={i} className="h-8 animate-pulse rounded-lg bg-elevated" />)}
              </div>
            ) : matches ? (
              matches.length ? matches.map(n => (
                <button
                  key={n.path}
                  onClick={() => setDest(n.path)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors',
                    n.path === dest
                      ? 'bg-accent-light text-accent-hover font-medium'
                      : 'text-text-muted hover:text-text-primary hover:bg-elevated',
                  )}
                >
                  <Folder className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{n.path}</span>
                </button>
              )) : (
                <p className="px-2 py-3 text-center text-xs text-text-subtle">No folder matches "{filter}"</p>
              )
            ) : (
              <PickerNode node={tree} depth={0} selected={dest} onSelect={setDest} exclude={excludeFolder} />
            )}
          </div>

          <div className="flex items-center gap-2">
            <Input
              value={newFolder}
              onChange={e => setNewFolder(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); createHere(); } }}
              placeholder="New folder here…"
              autoComplete="off"
            />
            <Button
              variant="secondary"
              onClick={createHere}
              disabled={!newFolder.trim() || creating}
              title={`Create inside ${dest || 'Root'}`}
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderPlus className="h-4 w-4" />}
            </Button>
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <p className="min-w-0 truncate text-xs text-text-muted">
              Destination: <span className="font-medium text-text-primary">{dest || 'Root'}</span>
            </p>
            <div className="flex shrink-0 gap-2">
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button onClick={submit} disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                Move here
              </Button>
            </div>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
