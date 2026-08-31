import { create } from 'zustand';

// What is currently being dragged in the library. Native drag-and-drop can only
// read dataTransfer *contents* on drop, not on dragover — so drop targets need
// this store to decide, while the pointer is still moving, whether they are a
// legal destination and should light up.
export type { DragPayload } from '@/lib/dragRules';
export { canDrop } from '@/lib/dragRules';

import type { DragPayload } from '@/lib/dragRules';

interface DragState {
  payload: DragPayload | null;
  /** Folder path the pointer is currently over, so exactly one target lights up. */
  over: string | null;
  start: (payload: DragPayload) => void;
  setOver: (folder: string | null) => void;
  end: () => void;
}

export const useDragStore = create<DragState>((set, get) => ({
  payload: null,
  over: null,
  start: payload => set({ payload, over: null }),
  setOver: folder => { if (get().over !== folder) set({ over: folder }); },
  end: () => set({ payload: null, over: null }),
}));


/** MIME-ish keys so a drag from outside the app is never mistaken for ours. */
export const DRAG_VIDEOS = 'application/x-lostreamu-videos';
export const DRAG_FOLDER = 'application/x-lostreamu-folder';
