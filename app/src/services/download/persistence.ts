import fs from 'fs';
import { QUEUE_PATH } from '../../config';
import type { QueueItem } from './types';
import { isActive } from './types';

// Queue persistence — a single JSON file so an accidental restart doesn't lose
// queued/failed downloads. Writes are debounced to keep large-queue mutations cheap.


interface Persisted {
  version: 1;
  order: string[];
  items: QueueItem[];
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function saveQueue(order: string[], items: QueueItem[]): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const payload: Persisted = {
      version: 1,
      order,
      // Drop transient fields — they're meaningless after a restart.
      items: items.map(i => ({ ...i, speed: undefined, eta: undefined })),
    };
    try {
      fs.writeFileSync(QUEUE_PATH, JSON.stringify(payload));
    } catch { /* best-effort; queue still works in-memory */ }
  }, 250);
}

// Synchronous write — used to flush on process exit so the last mutation isn't
// lost inside the debounce window when the service is restarted.
export function saveQueueSync(order: string[], items: QueueItem[]): void {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    fs.writeFileSync(QUEUE_PATH, JSON.stringify({
      version: 1, order,
      items: items.map(i => ({ ...i, speed: undefined, eta: undefined })),
    }));
  } catch { /* best-effort */ }
}

// Load persisted queue. Any item that was mid-flight when the process died is
// reset to 'queued' so it resumes automatically (yt-dlp --continue reuses the
// partial file). Terminal items are kept as history.
export function loadQueue(): { order: string[]; items: QueueItem[] } {
  try {
    if (!fs.existsSync(QUEUE_PATH)) return { order: [], items: [] };
    const raw = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8')) as Persisted;
    const items = (raw.items || []).map(i => {
      if (isActive(i.state)) {
        return { ...i, state: 'queued' as const, progress: 0, speed: undefined, eta: undefined };
      }
      return { ...i, speed: undefined, eta: undefined };
    });
    // Only keep order entries that still have an item.
    const ids = new Set(items.map(i => i.id));
    const order = (raw.order || []).filter(id => ids.has(id));
    return { order, items };
  } catch {
    return { order: [], items: [] };
  }
}
