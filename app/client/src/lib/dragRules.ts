// Pure drag-and-drop rules, kept free of React and store imports so they can be
// unit-tested on their own.

export type DragPayload =
  | { kind: 'videos'; ids: string[]; label: string; sourceFolders: string[] }
  | { kind: 'folder'; path: string; label: string };

/**
 * Can `payload` be dropped on the folder `dest`? Rejects the no-ops (already
 * there, folder onto its own parent) and the impossible (a folder into itself
 * or one of its descendants).
 */
export function canDrop(payload: DragPayload | null, dest: string): boolean {
  if (!payload) return false;
  if (payload.kind === 'folder') {
    const parent = payload.path.includes('/') ? payload.path.slice(0, payload.path.lastIndexOf('/')) : '';
    if (dest === payload.path || dest === parent) return false;
    return !dest.startsWith(payload.path + '/');
  }
  // Dropping videos back where they already live is a no-op, not a move.
  return !payload.sourceFolders.every(f => f === dest);
}
