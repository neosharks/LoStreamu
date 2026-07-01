import { memo, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowLeft, Plus, Search, Trash2, Pause, Play, X, RotateCw,
  ChevronUp, ChevronDown, Download as DownloadIcon, FolderPlus, Loader2,
} from 'lucide-react';
import { downloadsApi } from '@/api/downloads';
import { videosApi } from '@/api/videos';
import { useSSE } from '@/hooks/useSSE';
import { PlaylistReviewModal } from '@/components/PlaylistReviewModal';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import type { DownloadJob, DownloadStatus } from '@/types';

type Filter = 'all' | 'active' | 'queued' | 'done' | 'failed';

const ACTIVE: DownloadStatus[] = ['starting', 'downloading', 'processing'];

const STATE_META: Record<DownloadStatus, { label: string; cls: string }> = {
  queued:      { label: 'Queued',      cls: 'bg-elevated text-text-muted' },
  starting:    { label: 'Preparing',   cls: 'bg-accent/15 text-accent' },
  downloading: { label: 'Downloading', cls: 'bg-accent/15 text-accent' },
  processing:  { label: 'Processing',  cls: 'bg-accent/15 text-accent' },
  paused:      { label: 'Paused',      cls: 'bg-warning/15 text-warning' },
  done:        { label: 'Completed',   cls: 'bg-success/15 text-success' },
  error:       { label: 'Failed',      cls: 'bg-danger/15 text-danger' },
};

// Flatten the folder tree into indented <option>s for the destination picker.
function folderOptionsFrom(paths: string[]): { path: string; label: string }[] {
  return [
    { path: '', label: 'Library (root)' },
    ...paths.map(p => ({ path: p, label: p })),
  ];
}

// ── One queue row (memoized so unchanged rows don't re-render on progress ticks) ──
interface RowProps {
  job: DownloadJob;
  index: number;
  total: number;
  onAction: (fn: () => Promise<unknown>) => void;
}
const JobRow = memo(function JobRow({ job, index, total, onAction }: RowProps) {
  const meta = STATE_META[job.status];
  const isActive = ACTIVE.includes(job.status);
  const isQueued = job.status === 'queued';
  const isPaused = job.status === 'paused';
  const isDone = job.status === 'done';
  const isError = job.status === 'error';
  const canMoveUp = isQueued && index > 0;
  const canMoveDown = isQueued && index < total - 1;

  const btn = 'flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors active:scale-95';

  return (
    <div
      className="flex items-center gap-3 border-b border-border/60 px-3 py-3 sm:px-4"
      style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 72px' }}
    >
      <div className="h-10 w-16 shrink-0 overflow-hidden rounded-md bg-elevated">
        <img src={`/api/download/${job.id}/thumb`} alt="" className="h-full w-full object-cover"
          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-text-primary">{job.title}</p>
          <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold', meta.cls)}>{meta.label}</span>
        </div>
        {isActive && (
          <>
            <Progress value={job.progress} className="mt-1.5 h-1" />
            <p className="mt-0.5 text-[11px] text-text-muted tabular-nums">
              {job.status === 'processing' ? 'Processing…' : `${job.progress.toFixed(0)}%`}
              {job.speed && <> · {job.speed}</>}{job.eta && <> · ETA {job.eta}</>}
            </p>
          </>
        )}
        {isQueued && <p className="mt-0.5 text-[11px] text-text-muted">{job.queuePos === 1 ? 'Next up' : `#${job.queuePos ?? ''} in queue`}</p>}
        {isError && <p className="mt-0.5 truncate text-[11px] text-danger">{job.error || 'Failed'}</p>}
        {job.folder && <p className="mt-0.5 truncate text-[11px] text-text-subtle">{job.folder}</p>}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {isQueued && (
          <div className="flex flex-col">
            <button disabled={!canMoveUp} onClick={() => onAction(() => downloadsApi.reorder(job.id, index - 1))}
              className={cn(btn, 'h-5', canMoveUp ? 'hover:text-text-primary' : 'opacity-30')} title="Move up"><ChevronUp className="h-4 w-4" /></button>
            <button disabled={!canMoveDown} onClick={() => onAction(() => downloadsApi.reorder(job.id, index + 1))}
              className={cn(btn, 'h-5', canMoveDown ? 'hover:text-text-primary' : 'opacity-30')} title="Move down"><ChevronDown className="h-4 w-4" /></button>
          </div>
        )}
        {isActive && <button onClick={() => onAction(() => downloadsApi.pause(job.id))} className={cn(btn, 'hover:text-text-primary hover:bg-elevated')} title="Pause"><Pause className="h-4 w-4" /></button>}
        {isPaused && <button onClick={() => onAction(() => downloadsApi.resume(job.id))} className={cn(btn, 'hover:text-accent hover:bg-accent/10')} title="Resume"><Play className="h-4 w-4" /></button>}
        {isError && <button onClick={() => onAction(() => downloadsApi.retry(job.id))} className={cn(btn, 'hover:text-accent hover:bg-accent/10')} title="Retry"><RotateCw className="h-4 w-4" /></button>}
        {(isActive || isQueued || isPaused) && <button onClick={() => onAction(() => downloadsApi.cancel(job.id))} className={cn(btn, 'hover:text-danger hover:bg-danger/10')} title="Cancel"><X className="h-4 w-4" /></button>}
        {(isDone || isError) && <button onClick={() => onAction(() => downloadsApi.dismiss(job.id))} className={cn(btn, 'hover:text-danger hover:bg-danger/10')} title="Remove"><Trash2 className="h-4 w-4" /></button>}
      </div>
    </div>
  );
});

export function Downloads() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  // Add bar
  const [url, setUrl] = useState('');
  const [folder, setFolder] = useState('');
  const [isPlaylist, setIsPlaylist] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolder, setNewFolder] = useState('');

  const { data: allFolders = [] } = useQuery({ queryKey: ['folders-all'], queryFn: videosApi.allFolders });
  const folderOptions = useMemo(() => folderOptionsFrom(allFolders), [allFolders]);

  // One SSE connection observes the entire queue (efficient for large queues).
  useSSE<DownloadJob[]>('/api/downloads/events', (name, data) => {
    if (name === 'queue' && Array.isArray(data)) setJobs(data);
  });
  useEffect(() => { downloadsApi.list().then(setJobs).catch(() => {}); }, []);

  const addMutation = useMutation({
    mutationFn: () => downloadsApi.start(url.trim(), folder),
    onSuccess: () => { setUrl(''); toast.success('Added to queue'); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not add download'),
  });

  const createFolderMutation = useMutation({
    mutationFn: () => videosApi.createFolder(newFolder.trim(), folder),
    onSuccess: () => {
      const path = folder ? `${folder}/${newFolder.trim()}` : newFolder.trim();
      toast.success('Folder created');
      setNewFolder(''); setNewFolderOpen(false);
      qc.invalidateQueries({ queryKey: ['tree'] });
      qc.invalidateQueries({ queryKey: ['folders-all'] }).then(() => setFolder(path));
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not create folder'),
  });

  // Fire an action, then let the whole-queue SSE push the new state back.
  const runAction = (fn: () => Promise<unknown>) => { fn().catch(() => {}); };

  const looksLikePlaylist = (v: string) => /[?&]list=|\/playlist|\/sets\/|\/album\//i.test(v);

  // Playlist → open the review modal; single URL → enqueue directly.
  const submitAdd = () => {
    if (!url.trim()) return;
    if (isPlaylist) setReviewOpen(true);
    else addMutation.mutate();
  };

  const counts = useMemo(() => ({
    all: jobs.length,
    active: jobs.filter(j => ACTIVE.includes(j.status)).length,
    queued: jobs.filter(j => j.status === 'queued' || j.status === 'paused').length,
    done: jobs.filter(j => j.status === 'done').length,
    failed: jobs.filter(j => j.status === 'error').length,
  }), [jobs]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return jobs.filter(j => {
      if (q && !(`${j.title} ${j.url}`.toLowerCase().includes(q))) return false;
      switch (filter) {
        case 'active': return ACTIVE.includes(j.status);
        case 'queued': return j.status === 'queued' || j.status === 'paused';
        case 'done': return j.status === 'done';
        case 'failed': return j.status === 'error';
        default: return true;
      }
    });
  }, [jobs, search, filter]);

  const hasFinished = jobs.some(j => ['done', 'error'].includes(j.status));

  const chips: { key: Filter; label: string }[] = [
    { key: 'all', label: 'All' }, { key: 'active', label: 'Active' },
    { key: 'queued', label: 'Queued' }, { key: 'done', label: 'Completed' },
    { key: 'failed', label: 'Failed' },
  ];

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg">
      {/* Top bar */}
      <header className="flex items-center gap-3 border-b border-border px-3 py-3 sm:px-4"
        style={{ paddingTop: 'max(env(safe-area-inset-top, 0px), 12px)' }}>
        <button onClick={() => navigate('/')} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-elevated hover:text-text-primary" aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <DownloadIcon className="h-4 w-4 text-accent" />
          <h1 className="truncate text-base font-semibold text-text-primary">Downloads</h1>
          <span className="text-xs text-text-muted">{counts.all}</span>
        </div>
        <button
          onClick={() => runAction(() => downloadsApi.clear())}
          disabled={!hasFinished}
          className={cn('rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
            hasFinished ? 'text-text-muted hover:bg-elevated hover:text-text-primary' : 'text-text-subtle opacity-40')}
        >
          Clear finished
        </button>
      </header>

      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-hidden px-3 sm:px-4">
        {/* Add bar */}
        <div className="space-y-2 py-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={url}
              onChange={e => { setUrl(e.target.value); if (looksLikePlaylist(e.target.value)) setIsPlaylist(true); }}
              onKeyDown={e => { if (e.key === 'Enter') submitAdd(); }}
              placeholder="Paste a video or playlist URL…"
              className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <div className="flex gap-2">
              <select value={folder} onChange={e => setFolder(e.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent sm:w-40 sm:flex-none">
                {folderOptions.map(o => <option key={o.path} value={o.path}>{o.label}</option>)}
              </select>
              <button onClick={() => setNewFolderOpen(v => !v)} title="New folder"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border text-text-muted hover:bg-elevated hover:text-text-primary">
                <FolderPlus className="h-4 w-4" />
              </button>
              <button onClick={submitAdd} disabled={!url.trim() || addMutation.isPending}
                className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50">
                {addMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {isPlaylist ? 'Review' : 'Add'}
              </button>
            </div>
          </div>

          {/* Playlist toggle */}
          <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-text-muted select-none">
            <input type="checkbox" checked={isPlaylist} onChange={e => setIsPlaylist(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-accent" />
            This is a playlist (review &amp; pick videos before adding)
          </label>

          {newFolderOpen && (
            <div className="flex gap-2">
              <input value={newFolder} onChange={e => setNewFolder(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && newFolder.trim()) createFolderMutation.mutate(); }}
                placeholder="New folder name…" autoFocus
                className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent" />
              <button onClick={() => createFolderMutation.mutate()} disabled={!newFolder.trim() || createFolderMutation.isPending}
                className="rounded-lg bg-elevated px-4 text-sm font-medium text-text-primary hover:bg-border disabled:opacity-50">Create</button>
            </div>
          )}
        </div>

        {/* Search + filter chips */}
        <div className="flex flex-col gap-2 pb-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-subtle" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search downloads…"
              className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-accent" />
          </div>
          <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
            {chips.map(c => (
              <button key={c.key} onClick={() => setFilter(c.key)}
                className={cn('shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors',
                  filter === c.key ? 'bg-accent text-white' : 'bg-surface text-text-muted hover:bg-elevated')}>
                {c.label} <span className="opacity-70">{counts[c.key]}</span>
              </button>
            ))}
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto rounded-xl border border-border"
          style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
          {filtered.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center py-20 text-center">
              <DownloadIcon className="mb-3 h-10 w-10 text-text-subtle" />
              <p className="text-sm font-medium text-text-primary">
                {jobs.length === 0 ? 'No downloads yet' : 'Nothing matches this filter'}
              </p>
              <p className="mt-1 text-xs text-text-muted">Paste a URL above to add one</p>
            </div>
          ) : (
            filtered.map(job => (
              <JobRow key={job.id} job={job} index={jobs.indexOf(job)} total={jobs.length} onAction={runAction} />
            ))
          )}
        </div>
      </div>

      <PlaylistReviewModal
        open={reviewOpen}
        url={url}
        folder={folder}
        onClose={() => setReviewOpen(false)}
        onAdded={() => { setUrl(''); setIsPlaylist(false); }}
      />
    </div>
  );
}
