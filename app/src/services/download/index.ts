import { DownloadQueue } from './queue';
import { YtDlpEngine } from './engine';
import { rescan, buildMeta } from '../library';

// The one download queue for the whole app. UI/routes observe it; nobody else
// owns download state. Finished downloads leave the queue — they live in the
// library from then on.
export const downloadQueue = new DownloadQueue({ engine: new YtDlpEngine(), removeCompleted: true });

// When an item finishes, refresh the library so the new file shows up. Kept as
// an event subscription so the queue stays decoupled from the library service.
downloadQueue.on('completed', () => {
  rescan();
  buildMeta().catch(() => {});
});

// Flush the queue synchronously on shutdown so the last state change (e.g. a
// dismiss or a just-finished item) survives a service restart.
process.on('exit', () => downloadQueue.flush());
process.once('SIGTERM', () => { downloadQueue.flush(); process.exit(0); });
process.once('SIGINT', () => { downloadQueue.flush(); process.exit(0); });

export * from './types';
export { DownloadQueue } from './queue';
