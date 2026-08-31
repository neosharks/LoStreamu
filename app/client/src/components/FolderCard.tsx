import { useState } from 'react';
import { Folder, FolderOpen, MoreVertical, Pencil, Trash2, Move, Plus, CornerDownRight } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/utils';
import { useDragStore, DRAG_FOLDER, type DragPayload } from '@/stores/dragStore';
import { useFolderDrop } from '@/hooks/useFolderDrop';
import type { FolderTree } from '@/types';

interface FolderCardProps {
  node: FolderTree;
  onOpen: (path: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  onMove: (path: string) => void;
  onNewSubfolder: (parent: string) => void;
  onDropInto: (payload: DragPayload, dest: string) => void;
}

/**
 * A subfolder tile in the library grid. Folders were sidebar-only before, which
 * meant no way to see or reorganise them while looking at the files themselves —
 * these are both a way in and a drop target.
 */
export function FolderCard({
  node, onOpen, onRename, onDelete, onMove, onNewSubfolder, onDropInto,
}: FolderCardProps) {
  const [dragging, setDragging] = useState(false);
  const startDrag = useDragStore(s => s.start);
  const endDrag = useDragStore(s => s.end);
  const drop = useFolderDrop(node.path, onDropInto);

  const subfolders = node.children.length;

  return (
    <button
      onClick={() => onOpen(node.path)}
      draggable
      onDragStart={e => {
        setDragging(true);
        startDrag({ kind: 'folder', path: node.path, label: node.name });
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(DRAG_FOLDER, node.path);
        e.dataTransfer.setData('text/plain', node.name);
      }}
      onDragEnd={() => { setDragging(false); endDrag(); }}
      {...drop.handlers}
      title={`Open ${node.name}`}
      className={cn(
        'group/folder relative flex items-center gap-3 rounded-xl border bg-surface p-3 text-left transition-all duration-150',
        'hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-lg hover:shadow-accent/5',
        drop.active
          ? 'border-accent bg-accent-light ring-2 ring-accent/40'
          : 'border-border',
        dragging && 'opacity-40',
      )}
    >
      <span
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors',
          drop.active ? 'bg-accent text-white' : 'bg-elevated text-accent-hover',
        )}
      >
        {drop.active
          ? <CornerDownRight className="h-5 w-5" />
          : subfolders
          ? <FolderOpen className="h-5 w-5" />
          : <Folder className="h-5 w-5" />}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-text-primary">{node.name}</span>
        <span className="block text-xs text-text-muted">
          {drop.active
            ? 'Drop to move here'
            : [
                `${node.totalCount} video${node.totalCount === 1 ? '' : 's'}`,
                subfolders ? `${subfolders} folder${subfolders === 1 ? '' : 's'}` : '',
              ].filter(Boolean).join(' · ')}
        </span>
      </span>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <span
            role="button"
            tabIndex={0}
            onClick={e => { e.stopPropagation(); }}
            className="shrink-0 rounded-md p-1 text-text-subtle opacity-100 transition-colors hover:bg-elevated hover:text-text-primary lg:opacity-0 lg:group-hover/folder:opacity-100"
          >
            <MoreVertical className="h-4 w-4" />
          </span>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            className="z-50 min-w-40 overflow-hidden rounded-xl border border-border bg-elevated p-1 shadow-xl shadow-black/40 animate-fade-in"
          >
            {[
              { icon: Plus, label: 'New subfolder', onClick: () => onNewSubfolder(node.path) },
              { icon: Pencil, label: 'Rename', onClick: () => onRename(node.path) },
              { icon: Move, label: 'Move', onClick: () => onMove(node.path) },
              { icon: Trash2, label: 'Delete', onClick: () => onDelete(node.path), danger: true },
            ].map(({ icon: Icon, label, onClick, danger }) => (
              <DropdownMenu.Item
                key={label}
                onClick={onClick}
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm outline-none transition-colors',
                  danger ? 'text-danger hover:bg-danger/10' : 'text-text-primary hover:bg-border',
                )}
              >
                <Icon className="h-3.5 w-3.5" /> {label}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </button>
  );
}
