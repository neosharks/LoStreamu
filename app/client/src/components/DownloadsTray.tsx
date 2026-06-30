import { useState } from 'react';
import { Download, ChevronUp, ChevronDown, X, ListVideo, CheckCircle2, AlertCircle, Pause, Play } from 'lucide-react';
import { useDownloadsStore } from '@/stores/downloadsStore';
import { downloadsApi } from '@/api/downloads';
import { useSSE } from '@/hooks/useSSE';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import type { DownloadJob, BatchJob } from '@/types';

// ── Mini job row ──────────────────────────────────────────────────────────────

function TrayJobRow({ jobId, onOpenModal }: { jobId: string; onOpenModal: () => void }) {
  const { jobs, updateJob, removeJob } = useDownloadsStore();
  const job = jobs.find(j => j.id === jobId);

  // Subscribe for all non-terminal statuses — queued/paused need position updates too
  useSSE<Partial<DownloadJob>>(
    job && !['done', 'error'].includes(job.status) ? `/api/download/${job.id}/events` : null,
    (_, data) => updateJob(jobId, data),
  );

  if (!job) return null;

  const isActive  = ['starting', 'downloading', 'processing'].includes(job.status);
  const isQueued  = job.status === 'queued';
  const isPaused  = job.status === 'paused';
  const isDone    = job.status === 'done';
  const isError   = job.status === 'error';

  const dismiss       = () => { downloadsApi.dismiss(job.id).catch(() => {}); removeJob(job.id); };
  const handlePause   = () => downloadsApi.pause(job.id).catch(() => {});
  const handleResume  = () => downloadsApi.resume(job.id).catch(() => {});
  const handleCancel  = () => downloadsApi.cancel(job.id).catch(() => {});

  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5 hover:bg-elevated/60 transition-colors">
      <div className="h-9 w-14 shrink-0 overflow-hidden rounded-md bg-elevated">
        <img
          src={`/api/download/${job.id}/thumb`}
          className="h-full w-full object-cover"
          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
          alt=""
        />
      </div>

      <div className="min-w-0 flex-1 cursor-pointer" onClick={onOpenModal}>
        <p className="truncate text-xs font-medium text-text-primary leading-tight">{job.title}</p>
        {isActive && (
          <>
            <Progress value={job.progress} className="mt-1 h-1" />
            <p className="mt-0.5 text-[10px] text-text-muted">
              {job.status === 'processing' ? 'Processing…' : `${job.progress.toFixed(0)}%`}
              {job.speed && <> · {job.speed}</>}
              {job.eta && <> · ETA {job.eta}</>}
            </p>
          </>
        )}
        {isQueued && (
          <p className="mt-0.5 text-[10px] text-text-muted">
            {job.queuePos === 1 ? 'Next up' : job.queuePos !== undefined ? `#${job.queuePos} in queue` : 'Queued'}
          </p>
        )}
        {isPaused && (
          <p className="mt-0.5 text-[10px] text-text-muted">
            Paused{job.queuePos ? ` · #${job.queuePos} in queue` : ''}
          </p>
        )}
        {isDone && <p className="mt-0.5 text-[10px] text-success">Complete</p>}
        {isError && <p className="mt-0.5 text-[10px] text-danger truncate">{job.error || 'Failed'}</p>}
      </div>

      <div className="shrink-0 flex items-center gap-0.5">
        {isActive && (
          <button onClick={handlePause} title="Pause" className="rounded-full p-1 text-text-muted hover:text-text-primary hover:bg-elevated transition-colors">
            <Pause className="h-3 w-3" />
          </button>
        )}
        {isPaused && (
          <button onClick={handleResume} title="Resume" className="rounded-full p-1 text-text-muted hover:text-accent hover:bg-accent/10 transition-colors">
            <Play className="h-3 w-3" />
          </button>
        )}
        {(isActive || isQueued || isPaused) && (
          <button onClick={handleCancel} title="Cancel" className="rounded-full p-1 text-text-muted hover:text-danger hover:bg-danger/10 transition-colors">
            <X className="h-3 w-3" />
          </button>
        )}
        {isDone && (
          <button onClick={dismiss} className="rounded-full p-1 text-success hover:bg-success/10 transition-colors" title="Dismiss">
            <CheckCircle2 className="h-3.5 w-3.5" />
          </button>
        )}
        {isError && (
          <button onClick={dismiss} className="rounded-full p-1 text-danger hover:bg-danger/10 transition-colors" title="Dismiss">
            <AlertCircle className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Mini batch row ────────────────────────────────────────────────────────────

function TrayBatchRow({ batchId, onOpenModal }: { batchId: string; onOpenModal: () => void }) {
  const { batches, updateBatch, removeBatch } = useDownloadsStore();
  const batch = batches.find(b => b.id === batchId);
  const active = batch ? ['running', 'paused'].includes(batch.status) : false;

  useSSE<BatchJob>(
    active && batch ? `/api/batch/${batch.id}/events` : null,
    (_, data) => updateBatch(batchId, data),
  );

  if (!batch) return null;
  const pct = batch.total > 0 ? Math.round((batch.done / batch.total) * 100) : 0;
  const isDone = batch.status === 'done' || batch.status === 'stopped';
  const isError = batch.status === 'error';

  const dismiss = () => {
    downloadsApi.dismissBatch(batch.id).catch(() => {});
    removeBatch(batch.id);
  };

  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5 hover:bg-elevated/60 transition-colors">
      <div className="flex h-9 w-14 shrink-0 items-center justify-center rounded-md bg-elevated">
        <ListVideo className="h-4 w-4 text-accent" />
      </div>

      <div className="min-w-0 flex-1 cursor-pointer" onClick={onOpenModal}>
        <p className="truncate text-xs font-medium text-text-primary leading-tight">{batch.title}</p>
        <div className="mt-1 flex items-center gap-2">
          <Progress value={pct} className="flex-1 h-1" />
          <span className="shrink-0 text-[10px] text-text-muted whitespace-nowrap">
            {batch.done}/{batch.total}
          </span>
        </div>
        {batch.paused && <p className="mt-0.5 text-[10px] text-text-muted">Paused</p>}
      </div>

      <div className="shrink-0 flex items-center">
        {(isDone || isError) && (
          <button onClick={dismiss} className="rounded-full p-1 text-text-muted hover:bg-elevated transition-colors" title="Dismiss">
            {isError
              ? <AlertCircle className="h-3.5 w-3.5 text-danger" />
              : <X className="h-3.5 w-3.5" />}
          </button>
        )}
        {active && !batch.paused && <div className="h-2 w-2 rounded-full bg-accent animate-pulse mx-1" />}
      </div>
    </div>
  );
}

// ── Tray shell ────────────────────────────────────────────────────────────────

interface DownloadsTrayProps {
  onOpenModal: () => void;
}

export function DownloadsTray({ onOpenModal }: DownloadsTrayProps) {
  const { jobs, batches } = useDownloadsStore();
  const [expanded, setExpanded] = useState(true);

  if (jobs.length === 0 && batches.length === 0) return null;

  const pendingJobs   = jobs.filter(j => !['done', 'error'].includes(j.status));
  const activeJobs    = jobs.filter(j => ['starting', 'downloading', 'processing'].includes(j.status));
  const activeBatches = batches.filter(b => b.status === 'running');
  const totalPending  = pendingJobs.length + activeBatches.length;

  // Aggregate progress bar for downloading jobs only
  const avgProgress = activeJobs.length > 0
    ? activeJobs.reduce((s, j) => s + j.progress, 0) / activeJobs.length
    : 0;

  const headerLabel = totalPending > 0
    ? `${totalPending} download${totalPending > 1 ? 's' : ''} pending`
    : `${jobs.length + batches.length} download${jobs.length + batches.length > 1 ? 's' : ''}`;

  // Sort: in-queue items by queuePos, then done/error by startedAt DESC
  const sortedJobs = [...jobs].sort((a, b) => {
    const aQ = a.queuePos ?? Infinity;
    const bQ = b.queuePos ?? Infinity;
    if (aQ !== bQ) return aQ - bQ;
    return b.startedAt - a.startedAt;
  });

  return (
    <div
      className={cn(
        'fixed bottom-4 right-4 z-40 w-80 overflow-hidden rounded-2xl border border-border bg-surface/95 shadow-2xl backdrop-blur-md',
        'animate-in slide-in-from-bottom-4 fade-in duration-200',
      )}
    >
      {/* Header — click to collapse/expand */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="flex w-full items-center gap-3 px-4 py-3 hover:bg-elevated/50 transition-colors text-left"
      >
        <div className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
          totalPending > 0 ? 'bg-accent/15 text-accent' : 'bg-elevated text-text-muted',
        )}>
          <Download className="h-3.5 w-3.5" />
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text-primary leading-tight">{headerLabel}</p>
          {activeJobs.length > 0 && avgProgress > 0 && (
            <Progress value={avgProgress} className="mt-1.5 h-1" />
          )}
        </div>

        <div className="shrink-0 text-text-muted">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
        </div>
      </button>

      {/* Item list */}
      {expanded && (
        <>
          <div className="max-h-72 overflow-y-auto divide-y divide-border/40 border-t border-border">
            {sortedJobs.map(j => (
              <TrayJobRow key={j.id} jobId={j.id} onOpenModal={onOpenModal} />
            ))}
            {batches.map(b => (
              <TrayBatchRow key={b.id} batchId={b.id} onOpenModal={onOpenModal} />
            ))}
          </div>

          <div className="border-t border-border px-4 py-2.5">
            <button
              onClick={onOpenModal}
              className="w-full rounded-lg py-1 text-xs font-medium text-accent hover:bg-accent/10 transition-colors"
            >
              Manage downloads →
            </button>
          </div>
        </>
      )}
    </div>
  );
}
