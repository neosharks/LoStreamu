import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Wrench, X, Check, AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import { repairApi } from '@/api/videos';
import { cn } from '@/lib/utils';
import type { RepairJob } from '@/types';

// Floating progress for video repairs, stacked above the downloads tray so the
// two never fight for the same corner. It only exists while something is being
// rebuilt, plus a short tail so a finished repair is not missed.
//
// A repair rewrites the file and (when the extension changes) its id, so the
// library has to be refetched the moment one lands — otherwise the grid keeps
// showing a card that now points at nothing.

const POLL_MS = 1500;
const ACTIVE: RepairJob['status'][] = ['queued', 'running'];

/**
 * The repair queue, polled only while something is pending. Deriving the
 * interval from the cached data rather than from local state matters: the tray
 * and the library both read this, and two observers holding their own timers
 * would double the request rate for no benefit.
 */
export function useRepairJobs() {
  const { data: jobs = [] } = useQuery({
    queryKey: ['repair'],
    queryFn: repairApi.jobs,
    refetchInterval: query =>
      (query.state.data?.some(j => ACTIVE.includes(j.status)) ? POLL_MS : false),
    staleTime: 0,
  });
  return { jobs };
}

export function RepairTray() {
  const qc = useQueryClient();
  const { jobs } = useRepairJobs();
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [lastActive, setLastActive] = useState(0);

  const active = jobs.filter(j => ACTIVE.includes(j.status));
  const settled = jobs.filter(j => !ACTIVE.includes(j.status) && !dismissed.includes(j.id));

  // When the last repair finishes, the files on disk have changed underneath the
  // library — ids included. Refetch rather than leaving a stale grid.
  useEffect(() => {
    if (active.length === 0 && lastActive > 0) {
      qc.invalidateQueries({ queryKey: ['videos'] });
      qc.invalidateQueries({ queryKey: ['favorites'] });
      qc.invalidateQueries({ queryKey: ['folder-health'] });
      qc.invalidateQueries({ queryKey: ['tree'] });
    }
    setLastActive(active.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.length]);

  const shown = [...active, ...settled].slice(0, 4);
  if (!shown.length) return null;

  const dismissAll = () => setDismissed(d => [...d, ...settled.map(j => j.id)]);

  return (
    <div className="fixed bottom-40 right-4 z-40 w-80 overflow-hidden rounded-2xl border border-border bg-surface/95 shadow-2xl backdrop-blur-md lg:bottom-24 animate-in slide-in-from-bottom-4 fade-in duration-200">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Wrench className={cn('h-4 w-4 text-accent', active.length > 0 && 'animate-pulse')} />
        <p className="flex-1 text-sm font-semibold text-text-primary">
          {active.length ? `Fixing ${active.length} ${active.length === 1 ? 'video' : 'videos'}` : 'Repairs finished'}
        </p>
        {settled.length > 0 && (
          <button
            onClick={dismissAll}
            title="Dismiss"
            className="rounded-lg p-1 text-text-muted transition-colors hover:bg-elevated hover:text-text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="max-h-64 space-y-2 overflow-y-auto p-3">
        {shown.map(job => (
          <div key={job.id} className="space-y-1.5">
            <div className="flex items-center gap-2">
              {job.status === 'running' ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
                : job.status === 'done' ? <Check className="h-3.5 w-3.5 shrink-0 text-accent" />
                : job.deleted ? <Trash2 className="h-3.5 w-3.5 shrink-0 text-danger" />
                : job.status === 'error' ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-danger" />
                : <Wrench className="h-3.5 w-3.5 shrink-0 text-text-subtle" />}
              <p className="min-w-0 flex-1 truncate text-xs font-medium text-text-primary">{job.name}</p>
              {ACTIVE.includes(job.status) && (
                <button
                  onClick={() => repairApi.cancel(job.id).catch(() => {})}
                  title="Cancel"
                  className="rounded p-0.5 text-text-subtle hover:text-danger"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <p className="pl-5 text-[11px] text-text-muted">
              {job.status === 'queued' ? 'Waiting — one repair runs at a time'
                : job.status === 'running' ? (job.plan === 'transcode' ? `Re-encoding · ${job.progress}%` : `Repacking · ${job.progress}%`)
                : job.status === 'done' ? 'Fixed — it plays now'
                : job.status === 'cancelled' ? 'Cancelled — the original is untouched'
                : job.deleted ? (job.error || 'Could not be fixed — deleted')
                : job.error || 'Failed'}
            </p>
            {ACTIVE.includes(job.status) && (
              <div className="h-1 w-full overflow-hidden rounded-full bg-border">
                <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${job.progress}%` }} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
