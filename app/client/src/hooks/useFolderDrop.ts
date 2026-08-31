import { useDragStore, canDrop, type DragPayload } from '@/stores/dragStore';

export interface FolderDropTarget {
  /** True while a legal drag is hovering this folder — drives the highlight. */
  active: boolean;
  /** True while a legal drag is in flight anywhere — dims illegal targets. */
  eligible: boolean;
  handlers: {
    onDragOver: (e: React.DragEvent) => void;
    onDragEnter: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
}

/**
 * Makes any element a destination for dragged videos or a dragged folder.
 * Shared by the sidebar tree, the folder tiles in the grid, and the breadcrumbs
 * so all three behave identically.
 */
export function useFolderDrop(
  folder: string,
  onDrop: (payload: DragPayload, dest: string) => void,
): FolderDropTarget {
  const { payload, over, setOver, end } = useDragStore();
  const eligible = canDrop(payload, folder);

  return {
    active: eligible && over === folder,
    eligible,
    handlers: {
      onDragEnter: e => { if (!eligible) return; e.preventDefault(); setOver(folder); },
      onDragOver: e => {
        if (!eligible) return;
        // Only a preventDefault'd dragover marks the element as a drop zone.
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setOver(folder);
      },
      // Children bubble their own leave events up, so ignore any leave that is
      // still inside this element — otherwise the highlight flickers.
      onDragLeave: e => {
        const to = e.relatedTarget as Node | null;
        if (to && e.currentTarget.contains(to)) return;
        if (over === folder) setOver(null);
      },
      onDrop: e => {
        e.preventDefault();
        e.stopPropagation();
        const p = payload;
        end();
        if (p && eligible) onDrop(p, folder);
      },
    },
  };
}
