import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Link2, ListVideo, Upload, X, Play, Loader2,
  ChevronDown, ChevronUp, SkipForward, Pause, Square,
} from 'lucide-react';

import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Progress } from './ui/progress';
import { downloadsApi } from '@/api/downloads';
import { videosApi } from '@/api/videos';
import { useSSE } from '@/hooks/useSSE';
import { useDownloadsStore } from '@/stores/downloadsStore';
import { formatBytes } from '@/lib/utils';
import type { DownloadJob, BatchJob, BatchItem, PlaylistEntry } from '@/types';

type Tab = 'url' | 'upload';

interface AddVideosModalProps {
  open: boolean;
  onClose: () => void;
  currentFolder?: string;
}

// ── Individual download card ──────────────────────────────────────────────────

function DownloadItem({ jobId, onDismiss }: { jobId: string; onDismiss: (id: string) => void }) {
  const { jobs, updateJob } = useDownloadsStore();
  const job = jobs.find(j => j.id === jobId);

  // Subscribe for all non-terminal statuses — queued/paused also need position updates
  useSSE<Partial<DownloadJob>>(
    job && !['done', 'error'].includes(job.status) ? `/api/download/${job.id}/events` : null,
    (_, data) => updateJob(jobId, data),
  );

  if (!job) return null;

  const isActive = ['starting', 'downloading', 'processing'].includes(job.status);
  const isQueued = job.status === 'queued';
  const isPaused = job.status === 'paused';
  const isDone = job.status === 'done';
  const isError = job.status === 'error';

  const handlePause  = () => downloadsApi.pause(job.id).catch(() => {});
  const handleResume = () => downloadsApi.resume(job.id).catch(() => {});
  const handleCancel = () => downloadsApi.cancel(job.id).catch(() => {});

  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="flex items-start gap-3">
        <div className="h-10 w-16 shrink-0 overflow-hidden rounded-md bg-elevated">
          <img src={`/api/download/${job.id}/thumb`} className="h-full w-full object-cover"
            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="truncate text-sm font-medium text-text-primary">{job.title}</p>
            <div className="flex items-center gap-1 shrink-0">
              {/* Queue position chip */}
              {isQueued && job.queuePos !== undefined && (
                <span className="rounded bg-elevated px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
                  {job.queuePos === 1 ? 'Next up' : `#${job.queuePos} queued`}
                </span>
              )}
              {isPaused && (
                <span className="rounded bg-elevated px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
                  Paused{job.queuePos ? ` · #${job.queuePos}` : ''}
                </span>
              )}
              {/* Action buttons */}
              {isActive && (
                <button onClick={handlePause} title="Pause" className="rounded p-0.5 text-text-muted hover:text-text-primary hover:bg-elevated transition-colors">
                  <Pause className="h-3 w-3" />
                </button>
              )}
              {isPaused && (
                <button onClick={handleResume} title="Resume" className="rounded p-0.5 text-text-muted hover:text-accent hover:bg-accent/10 transition-colors">
                  <Play className="h-3 w-3" />
                </button>
              )}
              {(isActive || isQueued || isPaused) && (
                <button onClick={handleCancel} title="Cancel" className="rounded p-0.5 text-text-muted hover:text-danger hover:bg-danger/10 transition-colors">
                  <X className="h-3 w-3" />
                </button>
              )}
              {(isDone || isError) && (
                <button onClick={() => onDismiss(job.id)} title="Dismiss" className="rounded p-0.5 text-text-muted hover:text-text-primary hover:bg-elevated transition-colors">
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
          {isActive && <Progress value={job.progress} className="mt-1.5" />}
          {isActive && (
            <p className="mt-0.5 text-xs text-text-muted">
              {job.status === 'processing' ? 'Processing…' : `${job.progress.toFixed(0)}%`}
              {job.speed && <> · {job.speed}</>}
              {job.eta && <> · ETA {job.eta}</>}
            </p>
          )}
          {isDone && <p className="mt-0.5 text-xs text-success">Complete</p>}
          {isError && <p className="mt-0.5 text-xs text-danger line-clamp-2">{job.error || 'Failed'}</p>}
        </div>
      </div>
    </div>
  );
}

// ── Per-item row inside a batch ───────────────────────────────────────────────

function BatchItemRow({
  item, batchId, active,
}: { item: BatchItem; batchId: string; active: boolean }) {
  const cancelMutation = useMutation({
    mutationFn: () => downloadsApi.cancelBatchItem(batchId, item.index),
    onError: () => toast.error('Could not cancel item'),
  });

  const isDownloading = item.status === 'downloading';
  const isPending = item.status === 'pending';

  return (
    <div className={`flex items-center gap-2 rounded-lg px-3 py-2 transition-colors ${
      isDownloading ? 'bg-elevated' : 'hover:bg-elevated/50'
    }`}>
      {/* Status indicator */}
      <div className="shrink-0 w-4 flex justify-center">
        {item.status === 'done' && <div className="h-2 w-2 rounded-full bg-success" />}
        {item.status === 'error' && <div className="h-2 w-2 rounded-full bg-danger" />}
        {item.status === 'skipped' && <div className="h-2 w-2 rounded-full bg-text-subtle" />}
        {isPending && <div className="h-2 w-2 rounded-full bg-border" />}
        {isDownloading && <div className="h-2 w-2 rounded-full bg-accent animate-pulse" />}
      </div>

      {/* Thumbnail if available */}
      {item.thumbnail && (
        <div className="h-8 w-12 shrink-0 overflow-hidden rounded bg-elevated">
          <img src={item.thumbnail} className="h-full w-full object-cover"
            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        </div>
      )}

      {/* Title + progress */}
      <div className="min-w-0 flex-1">
        <p className={`truncate text-xs font-medium ${
          item.status === 'skipped' ? 'text-text-subtle line-through' :
          item.status === 'done' ? 'text-text-secondary' : 'text-text-primary'
        }`}>{item.title}</p>

        {isDownloading && (
          <div className="mt-1 flex items-center gap-2">
            <Progress value={item.progress} className="flex-1 h-1" />
            <span className="shrink-0 text-[10px] text-text-muted whitespace-nowrap">
              {item.progress.toFixed(0)}%
              {item.speed && <> · {item.speed}</>}
              {item.eta && <> · {item.eta}</>}
            </span>
          </div>
        )}

        {item.error && item.status === 'error' && (
          <p className="mt-0.5 truncate text-[10px] text-danger">{item.error}</p>
        )}
      </div>

      {/* Cancel button (pending or downloading) */}
      {active && (isPending || isDownloading) && (
        <button
          onClick={() => cancelMutation.mutate()}
          disabled={cancelMutation.isPending}
          title="Skip this video"
          className="shrink-0 rounded p-0.5 text-text-subtle hover:text-danger hover:bg-danger/10 transition-colors"
        >
          {isDownloading ? <SkipForward className="h-3 w-3" /> : <X className="h-3 w-3" />}
        </button>
      )}
    </div>
  );
}

// ── Batch download card ───────────────────────────────────────────────────────

function BatchCard({ batchId, onDismiss }: { batchId: string; onDismiss: (id: string) => void }) {
  const { batches, updateBatch } = useDownloadsStore();
  const job = batches.find(b => b.id === batchId);
  const [expanded, setExpanded] = useState(true);
  const active = job ? (job.status === 'running' || job.status === 'paused') : false;

  useSSE<BatchJob>(
    active && job ? `/api/batch/${job.id}/events` : null,
    (_, data) => updateBatch(batchId, data),
  );

  if (!job) return null;

  const overallPct = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
  const activeCount = (job.items || []).filter(i => i.status === 'downloading').length;

  return (
    <div className="rounded-xl border border-border bg-surface overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-3 py-2.5 border-b border-border">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <ListVideo className="h-3.5 w-3.5 shrink-0 text-accent" />
            <p className="truncate text-sm font-medium text-text-primary">{job.title}</p>
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium capitalize ${
              job.status === 'done' ? 'bg-success/15 text-success' :
              job.status === 'error' ? 'bg-danger/15 text-danger' :
              'bg-elevated text-text-muted'
            }`}>
              {job.paused ? 'paused' : job.status}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-3">
            <Progress value={overallPct} className="flex-1 h-1" />
            <span className="shrink-0 text-[11px] text-text-muted whitespace-nowrap">
              {job.done}/{job.total}
              {activeCount > 0 && <> · {activeCount} active</>}
            </span>
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-1 shrink-0">
          {active && (
            <>
              {job.paused ? (
                <Button size="icon-sm" variant="secondary" onClick={() => downloadsApi.resumeBatch(job.id)} title="Resume">
                  <Play className="h-3 w-3" />
                </Button>
              ) : (
                <Button size="icon-sm" variant="secondary" onClick={() => downloadsApi.pauseBatch(job.id)} title="Pause (lets active downloads finish)">
                  <Pause className="h-3 w-3" />
                </Button>
              )}
              <Button size="icon-sm" variant="danger" onClick={() => downloadsApi.stopBatch(job.id)} title="Stop all">
                <Square className="h-3 w-3" />
              </Button>
            </>
          )}
          {!active && (
            <button onClick={() => onDismiss(job.id)} className="p-0.5 text-text-muted hover:text-text-primary" title="Dismiss">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={() => setExpanded(e => !e)}
            className="p-0.5 text-text-muted hover:text-text-primary ml-0.5"
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* Item list */}
      {expanded && (job.items || []).length > 0 && (
        <div className="max-h-72 overflow-y-auto py-1">
          {job.items.map(item => (
            <BatchItemRow
              key={item.index}
              item={item}
              batchId={job.id}
              active={active}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────

export function AddVideosModal({ open, onClose, currentFolder }: AddVideosModalProps) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('url');
  const [url, setUrl] = useState('');
  const [folder, setFolder] = useState(currentFolder ?? '');
  const [concurrency, setConcurrency] = useState(2);
  const [isPlaylist, setIsPlaylist] = useState(false);
  const [probe, setProbe] = useState<{ title: string; entries: PlaylistEntry[] } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [filename, setFilename] = useState('');
  const [createSubfolder, setCreateSubfolder] = useState(true);
  const [subfolderName, setSubfolderName] = useState(() => randomFolderName());
  const { jobs, batches, addJob, addBatch, removeJob, removeBatch } = useDownloadsStore();
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  // All folders on disk (incl. empty) so you can download into any existing folder.
  const { data: folderPaths = [] } = useQuery({ queryKey: ['folders-all'], queryFn: videosApi.allFolders });
  const allFolders = ['', ...folderPaths];

  const { data: archiveFolders = [] } = useQuery({
    queryKey: ['folders-archives'],
    queryFn: videosApi.archiveFolders,
    enabled: isPlaylist,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!open) return;
    setFolder(currentFolder ?? '');
    setSubfolderName(randomFolderName());
  }, [open, currentFolder]);

  const probeMutation = useMutation({
    mutationFn: () => downloadsApi.probePlaylist(url),
    onSuccess: data => {
      setProbe(data);
      setSelected(new Set(data.entries.map(e => e.index)));
      setSubfolderName(sanitizeName(data.title));
    },
    onError: (err: any) => toast.error(err.response?.data?.error || 'Failed to read playlist'),
  });

  const downloadMutation = useMutation({
    mutationFn: async () => {
      if (isPlaylist && probe) {
        const destFolder = createSubfolder && subfolderName.trim()
          ? (folder ? `${folder}/${subfolderName.trim()}` : subfolderName.trim())
          : folder;
        const items = probe.entries
          .filter(e => selected.has(e.index))
          .map(e => ({ index: e.index, title: e.title, url: e.url, thumbnail: e.thumbnail }));
        return downloadsApi.startBatch({ url, folder: destFolder, title: probe.title, concurrency, items });
      }
      return downloadsApi.start(url, folder, filename.trim() || undefined);
    },
    onSuccess: (data: any) => {
      if (data?.jobs) {
        // Playlist: each entry is now an individual job in the central queue.
        const destFolder = createSubfolder && subfolderName.trim()
          ? (folder ? `${folder}/${subfolderName.trim()}` : subfolderName.trim())
          : folder;
        for (const j of data.jobs as { id: string; url: string }[]) {
          addJob({
            id: j.id, url: j.url, title: 'Fetching info…',
            status: 'queued', progress: 0, folder: destFolder, startedAt: Date.now(),
          });
        }
        if (data.duplicates) toast.info(`${data.duplicates} already in the queue — skipped`);
        qc.invalidateQueries({ queryKey: ['tree'] });
        setUrl(''); setProbe(null); setFilename('');
        qc.invalidateQueries({ queryKey: ['videos'] });
      } else if (data?.id) {
        addJob({
          id: data.id, url, title: 'Fetching info…',
          status: 'queued', progress: 0, folder, startedAt: Date.now(),
        });
        setUrl(''); setProbe(null); setFilename('');
        qc.invalidateQueries({ queryKey: ['videos'] });
      }
    },
    onError: (err: any) => toast.error(err.response?.data?.error || 'Download failed'),
  });

  const handleUpload = async () => {
    if (!selectedFile) return;
    try {
      setUploadProgress(0);
      await downloadsApi.upload(selectedFile, folder, setUploadProgress);
      toast.success('Uploaded successfully');
      setSelectedFile(null); setUploadProgress(null);
      qc.invalidateQueries({ queryKey: ['videos'] });
      qc.invalidateQueries({ queryKey: ['tree'] });
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Upload failed');
      setUploadProgress(null);
    }
  };

  const autoDetectPlaylist = (v: string) =>
    /[?&]list=|\/playlist|\/sets\/|\/album\/|\/model\/|\/pornstar\/|\/channels?\/|\/users?\/|@|c\/|channel\/|user\//i.test(v);

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Add videos</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">
          <DialogBody className="space-y-4">
            {/* Tabs */}
            <div className="flex rounded-lg border border-border bg-surface p-1 gap-1">
              {(['url', 'upload'] as Tab[]).map(t => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-md py-1.5 text-sm font-medium transition-colors
                    ${tab === t ? 'bg-elevated text-text-primary shadow-sm' : 'text-text-muted hover:text-text-primary'}`}
                >
                  {t === 'url' ? <Link2 className="h-3.5 w-3.5" /> : <Upload className="h-3.5 w-3.5" />}
                  {t === 'url' ? 'URL / Link' : 'Upload file'}
                </button>
              ))}
            </div>

            {/* Folder selector */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-text-muted">Save to folder</label>
              <select
                value={folder}
                onChange={e => setFolder(e.target.value)}
                className="w-full rounded-lg border border-border bg-elevated px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
              >
                {allFolders.map(f => <option key={f} value={f}>{f || '/ (root)'}</option>)}
              </select>
            </div>

            {tab === 'url' && (
              <>
                <div className="flex gap-2">
                  <Input
                    value={url}
                    onChange={e => {
                      setUrl(e.target.value);
                      if (autoDetectPlaylist(e.target.value)) setIsPlaylist(true);
                      setProbe(null);
                    }}
                    placeholder="https://youtube.com/watch?v=… or playlist URL"
                    onKeyDown={e => {
                      if (e.key === 'Enter')
                        isPlaylist ? probeMutation.mutate() : downloadMutation.mutate();
                    }}
                    className="flex-1"
                  />
                  <Button
                    onClick={() => isPlaylist ? probeMutation.mutate() : downloadMutation.mutate()}
                    disabled={!url.trim() || probeMutation.isPending || downloadMutation.isPending}
                  >
                    {probeMutation.isPending || downloadMutation.isPending
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : isPlaylist && !probe ? <ListVideo className="h-4 w-4" />
                      : <Play className="h-4 w-4" />}
                    {isPlaylist && !probe ? 'Preview' : 'Download'}
                  </Button>
                </div>

                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isPlaylist}
                      onChange={e => { setIsPlaylist(e.target.checked); setProbe(null); setFilename(''); }}
                      className="rounded accent-accent"
                    />
                    This is a playlist
                  </label>

                  {isPlaylist && (
                    <div className="flex items-center gap-2 text-sm text-text-muted">
                      <span>Parallel downloads:</span>
                      {[1, 2, 3].map(n => (
                        <button
                          key={n}
                          onClick={() => setConcurrency(n)}
                          className={`h-6 w-6 rounded text-xs font-medium transition-colors ${
                            concurrency === n
                              ? 'bg-accent text-white'
                              : 'bg-elevated hover:bg-border text-text-secondary'
                          }`}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Single video: custom filename */}
                {!isPlaylist && (
                  <Input
                    value={filename}
                    onChange={e => setFilename(e.target.value)}
                    placeholder="Save as… (leave blank to use video title)"
                    className="text-sm"
                  />
                )}

                {/* Playlist destination options */}
                {isPlaylist && (
                  <div className="space-y-2.5 rounded-xl border border-border bg-surface p-3">
                    {/* Create new subfolder */}
                    <label className="flex items-center gap-2.5 cursor-pointer">
                      <input
                        type="radio"
                        name="playlist-dest"
                        checked={createSubfolder}
                        onChange={() => setCreateSubfolder(true)}
                        className="accent-accent"
                      />
                      <span className="text-sm text-text-primary font-medium">New subfolder</span>
                    </label>
                    {createSubfolder && (
                      <div className="ml-5 flex gap-2">
                        <Input
                          value={subfolderName}
                          onChange={e => setSubfolderName(e.target.value)}
                          placeholder="Subfolder name"
                          className="flex-1 text-sm"
                        />
                        <button
                          onClick={() => setSubfolderName(randomFolderName())}
                          title="Generate random name"
                          className="rounded-lg border border-border bg-elevated px-2.5 text-text-muted hover:text-text-primary hover:bg-border transition-colors text-xs shrink-0"
                        >
                          ↺
                        </button>
                      </div>
                    )}

                    {/* Save into existing folder */}
                    <label className="flex items-center gap-2.5 cursor-pointer">
                      <input
                        type="radio"
                        name="playlist-dest"
                        checked={!createSubfolder}
                        onChange={() => setCreateSubfolder(false)}
                        className="accent-accent"
                      />
                      <span className="text-sm text-text-primary font-medium">Existing folder</span>
                      <span className="text-xs text-text-muted">(skips already-downloaded videos)</span>
                    </label>
                    {!createSubfolder && (
                      <div className="ml-5 space-y-2">
                        {archiveFolders.length > 0 && (
                          <div className="space-y-1">
                            <p className="text-[11px] text-text-subtle uppercase tracking-wider font-medium">Previous playlists</p>
                            <div className="flex flex-wrap gap-1.5">
                              {archiveFolders.map(f => (
                                <button
                                  key={f}
                                  onClick={() => setFolder(f)}
                                  className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors border ${
                                    folder === f
                                      ? 'bg-accent text-white border-accent'
                                      : 'bg-elevated border-border text-text-secondary hover:border-accent/50 hover:text-text-primary'
                                  }`}
                                >
                                  {f.split('/').pop()}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                        <select
                          value={folder}
                          onChange={e => setFolder(e.target.value)}
                          className="w-full rounded-lg border border-border bg-elevated px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                        >
                          {allFolders.map(f => (
                            <option key={f} value={f}>
                              {f || '/ (root)'}
                              {archiveFolders.includes(f) ? ' ✓' : ''}
                            </option>
                          ))}
                        </select>
                        {folder && archiveFolders.includes(folder) && (
                          <p className="text-xs text-success flex items-center gap-1">
                            <span>✓</span> Previously downloaded videos in this folder will be skipped automatically
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {probe && (
                  <div className="rounded-xl border border-border bg-surface overflow-hidden">
                    <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                      <p className="text-sm font-medium text-text-primary">{probe.title}</p>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-text-muted">{selected.size}/{probe.entries.length} selected</span>
                        <button onClick={() => setSelected(new Set(probe.entries.map(e => e.index)))} className="text-xs text-accent hover:underline">All</button>
                        <button onClick={() => setSelected(new Set())} className="text-xs text-text-muted hover:text-text-primary">None</button>
                      </div>
                    </div>
                    <div className="max-h-56 overflow-y-auto">
                      {probe.entries.map(entry => (
                        <label key={entry.index} className="flex items-center gap-3 px-4 py-2 hover:bg-elevated cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selected.has(entry.index)}
                            onChange={e => setSelected(prev => {
                              const s = new Set(prev);
                              e.target.checked ? s.add(entry.index) : s.delete(entry.index);
                              return s;
                            })}
                            className="rounded accent-accent shrink-0"
                          />
                          {entry.thumbnail && (
                            <div className="h-7 w-12 shrink-0 overflow-hidden rounded bg-elevated">
                              <img src={entry.thumbnail} className="h-full w-full object-cover"
                                onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                            </div>
                          )}
                          <span className="flex-1 truncate text-sm text-text-primary">{entry.title}</span>
                          {entry.duration && (
                            <span className="text-xs text-text-muted shrink-0">
                              {Math.floor(entry.duration / 60)}:{String(Math.floor(entry.duration % 60)).padStart(2, '0')}
                            </span>
                          )}
                        </label>
                      ))}
                    </div>
                    <div className="border-t border-border px-4 py-3">
                      <Button
                        onClick={() => downloadMutation.mutate()}
                        disabled={!selected.size || downloadMutation.isPending}
                        className="w-full"
                      >
                        {downloadMutation.isPending
                          ? <Loader2 className="h-4 w-4 animate-spin" />
                          : <Play className="h-4 w-4" />}
                        Download {selected.size} {selected.size === 1 ? 'video' : 'videos'}
                        {concurrency > 1 && ` (${concurrency} at a time)`}
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}

            {tab === 'upload' && (
              <div className="space-y-3">
                <div
                  className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-border py-10 text-center cursor-pointer hover:border-accent/50 hover:bg-accent/5 transition-colors"
                  onClick={() => fileRef.current?.click()}
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) setSelectedFile(f); }}
                >
                  <Upload className="mb-2 h-8 w-8 text-text-subtle" />
                  <p className="text-sm font-medium text-text-primary">Drop a video file here</p>
                  <p className="mt-1 text-xs text-text-muted">or click to browse · mp4, mkv, webm, avi…</p>
                  <input ref={fileRef} type="file" accept="video/*,.mkv,.avi,.flv,.wmv,.m2ts,.ts" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) setSelectedFile(f); }} />
                </div>
                {selectedFile && (
                  <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="truncate text-sm font-medium text-text-primary">{selectedFile.name}</p>
                        <p className="text-xs text-text-muted">{formatBytes(selectedFile.size)}</p>
                      </div>
                      <button onClick={() => { setSelectedFile(null); setUploadProgress(null); }} className="text-text-muted hover:text-text-primary">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    {uploadProgress !== null && <Progress value={uploadProgress} />}
                    <Button onClick={handleUpload} disabled={uploadProgress !== null} className="w-full">
                      {uploadProgress !== null
                        ? <><Loader2 className="h-4 w-4 animate-spin" /> Uploading {uploadProgress}%</>
                        : <><Upload className="h-4 w-4" /> Upload</>}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Active downloads */}
            {(jobs.length > 0 || batches.length > 0) && (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
                  Downloads · {jobs.length + batches.length}
                </p>
                {jobs.map(j => (
                  <DownloadItem
                    key={j.id}
                    jobId={j.id}
                    onDismiss={id => { downloadsApi.dismiss(id); removeJob(id); }}
                  />
                ))}
                {batches.map(b => (
                  <BatchCard
                    key={b.id}
                    batchId={b.id}
                    onDismiss={id => { downloadsApi.dismissBatch(id); removeBatch(id); }}
                  />
                ))}
              </div>
            )}
          </DialogBody>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function getFolderPaths(tree: any, acc: string[] = []): string[] {
  if (!tree) return acc;
  for (const child of tree.children || []) {
    acc.push(child.path);
    getFolderPaths(child, acc);
  }
  return acc;
}

function sanitizeName(s: string): string {
  return s.replace(/[<>:"|?*\\/]/g, '').trim().slice(0, 80);
}

const RAND_ADJ = ['amber', 'arctic', 'azure', 'cobalt', 'cosmic', 'cozy', 'crimson', 'crystal', 'dark', 'electric', 'emerald', 'epic', 'frozen', 'golden', 'indie', 'jade', 'midnight', 'neon', 'obsidian', 'pastel', 'prism', 'retro', 'rustic', 'shadow', 'silver', 'solar', 'velvet', 'violet', 'vivid', 'cyber'];
const RAND_NOUN = ['archive', 'cache', 'capsule', 'catalog', 'channel', 'chest', 'collection', 'depot', 'gallery', 'haven', 'hub', 'library', 'locker', 'mixtape', 'reel', 'shelf', 'stash', 'studio', 'trove', 'vault', 'zone'];

function randomFolderName(): string {
  const adj = RAND_ADJ[Math.floor(Math.random() * RAND_ADJ.length)];
  const noun = RAND_NOUN[Math.floor(Math.random() * RAND_NOUN.length)];
  return `${adj}-${noun}`;
}
