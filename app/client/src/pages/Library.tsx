import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Film, Search, Move, Trash2, X, Shuffle } from 'lucide-react';
import { Header } from '@/components/Header';
import { Sidebar } from '@/components/Sidebar';
import { VideoCard } from '@/components/VideoCard';
import { Player } from '@/components/Player';
import { AddVideosModal } from '@/components/AddVideosModal';
import { DownloadsTray } from '@/components/DownloadsTray';
import { StatsModal } from '@/components/StatsModal';
import { AccountModal } from '@/components/AccountModal';
import { RenameModal } from '@/components/RenameModal';
import { ConfirmModal } from '@/components/ConfirmModal';
import { MoveModal } from '@/components/MoveModal';
import { videosApi } from '@/api/videos';
import { downloadsApi } from '@/api/downloads';
import { usePlayerStore } from '@/stores/playerStore';
import { useDownloadsStore } from '@/stores/downloadsStore';
import type { Video } from '@/types';

type SortKey = 'addedAt' | 'addedAt-asc' | 'name' | 'name-desc' | 'size' | 'duration' | 'random';

function pseudoHash(id: string, seed: number): number {
  let h = (seed * 2654435761) >>> 0;
  for (let i = 0; i < id.length; i++) h = ((h * 31) + id.charCodeAt(i)) >>> 0;
  return h;
}

export function Library() {
  const qc = useQueryClient();
  const { video: nowPlaying, open: openPlayer } = usePlayerStore();
  const { hydrate } = useDownloadsStore();

  // Hydrate download state from server on mount (survives page refresh)
  useEffect(() => {
    Promise.all([downloadsApi.list(), downloadsApi.listBatches()])
      .then(([jobs, batches]) => hydrate(jobs, batches))
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [folder, setFolder] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('addedAt');
  const [shuffleSeed, setShuffleSeed] = useState(1);
  const [showAdd, setShowAdd] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showAccount, setShowAccount] = useState(false);

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const isSelecting = selectedIds.size > 0;

  // Video modals
  const [renameVideo, setRenameVideo] = useState<Video | null>(null);
  const [deleteVideos, setDeleteVideos] = useState<Video[]>([]);
  const [moveVideos, setMoveVideos] = useState<Video[]>([]);

  // Folder modals — null = closed, string = target path or parent
  const [createFolderParent, setCreateFolderParent] = useState<string | null>(null);
  const [renameFolderPath, setRenameFolderPath] = useState<string | null>(null);
  const [deleteFolderPath, setDeleteFolderPath] = useState<string | null>(null);
  const [moveFolderPath, setMoveFolderPath] = useState<string | null>(null);

  const { data: videos = [], isLoading } = useQuery({
    queryKey: ['videos', folder],
    queryFn: () => videosApi.list(folder),
    staleTime: 10_000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['videos'] });
    qc.invalidateQueries({ queryKey: ['tree'] });
  };

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => videosApi.rename(id, name),
    onSuccess: () => { toast.success('Renamed'); invalidate(); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Rename failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: (ids: string[]) => videosApi.delete(ids),
    onSuccess: () => { toast.success('Deleted'); setSelectedIds(new Set()); invalidate(); },
    onError: () => toast.error('Delete failed'),
  });

  const moveMutation = useMutation({
    mutationFn: ({ ids, dest }: { ids: string[]; dest: string }) => videosApi.move(ids, dest),
    onSuccess: () => { toast.success('Moved'); setSelectedIds(new Set()); invalidate(); },
    onError: () => toast.error('Move failed'),
  });

  const createFolderMutation = useMutation({
    mutationFn: ({ name, parent }: { name: string; parent: string }) => videosApi.createFolder(name, parent),
    onSuccess: () => { toast.success('Folder created'); invalidate(); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Create failed'),
  });

  const renameFolderMutation = useMutation({
    mutationFn: ({ folder: f, name }: { folder: string; name: string }) => videosApi.renameFolder(f, name),
    onSuccess: () => { toast.success('Folder renamed'); invalidate(); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Rename failed'),
  });

  const deleteFolderMutation = useMutation({
    mutationFn: (f: string) => videosApi.deleteFolder(f),
    onSuccess: () => { toast.success('Folder deleted'); if (folder === deleteFolderPath) setFolder(''); invalidate(); },
    onError: () => toast.error('Delete failed'),
  });

  const moveFolderMutation = useMutation({
    mutationFn: ({ folder: f, dest }: { folder: string; dest: string }) => videosApi.moveFolder(f, dest),
    onSuccess: () => { toast.success('Folder moved'); invalidate(); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Move failed'),
  });

  const filtered = useMemo(() => {
    let result = videos;
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(v => v.name.toLowerCase().includes(q) || v.folder.toLowerCase().includes(q));
    }
    const arr = [...result];
    if (sort === 'name') arr.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'name-desc') arr.sort((a, b) => b.name.localeCompare(a.name));
    else if (sort === 'size') arr.sort((a, b) => b.size - a.size);
    else if (sort === 'duration') arr.sort((a, b) => (b.duration || 0) - (a.duration || 0));
    else if (sort === 'addedAt-asc') arr.sort((a, b) => a.addedAt - b.addedAt);
    else if (sort === 'random') arr.sort((a, b) => pseudoHash(a.id, shuffleSeed) - pseudoHash(b.id, shuffleSeed));
    else arr.sort((a, b) => b.addedAt - a.addedAt); // addedAt (newest first)
    return arr;
  }, [videos, search, sort, shuffleSeed]);

  const toggleSelect = (video: Video) =>
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(video.id) ? next.delete(video.id) : next.add(video.id);
      return next;
    });

  const handlePlay = (video: Video) => openPlayer(video, filtered);

  const folderDisplayName = (path: string) => path.split('/').pop() || 'root';

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header
        onAddVideos={() => setShowAdd(true)}
        onStats={() => setShowStats(true)}
        onAccount={() => setShowAccount(true)}
        videoCount={videos.length}
        search={search}
        onSearch={setSearch}
      />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          selected={folder}
          onSelect={setFolder}
          onCreateFolder={parent => setCreateFolderParent(parent)}
          onRenameFolder={f => setRenameFolderPath(f)}
          onDeleteFolder={f => setDeleteFolderPath(f)}
          onMoveFolder={f => setMoveFolderPath(f)}
        />

        <main className="flex-1 overflow-y-auto">
          <div className="p-4 sm:p-6">
            {/* Toolbar */}
            <div className="mb-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-text-primary">
                  {folder || 'All videos'} · {filtered.length}
                </h2>
              </div>
              <div className="flex items-center gap-1.5">
                <label className="text-xs text-text-muted">Sort</label>
                <select
                  value={sort}
                  onChange={e => {
                    const v = e.target.value as SortKey;
                    if (v === 'random') setShuffleSeed(s => s + 1);
                    setSort(v);
                  }}
                  className="rounded-lg border border-border bg-elevated px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                >
                  <option value="addedAt">Newest first</option>
                  <option value="addedAt-asc">Oldest first</option>
                  <option value="name">Name A→Z</option>
                  <option value="name-desc">Name Z→A</option>
                  <option value="size">Largest first</option>
                  <option value="duration">Longest first</option>
                  <option value="random">Shuffle</option>
                </select>
                {sort === 'random' && (
                  <button
                    onClick={() => setShuffleSeed(s => s + 1)}
                    title="Re-shuffle"
                    className="rounded-lg border border-border bg-elevated p-1 text-text-muted hover:text-text-primary hover:bg-border transition-colors"
                  >
                    <Shuffle className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Bulk selection toolbar */}
            {isSelecting && (
              <div className="mb-4 flex items-center gap-3 rounded-xl border border-accent/30 bg-accent-light px-4 py-2.5">
                <span className="flex-1 text-sm font-medium text-accent-hover">
                  {selectedIds.size} selected
                </span>
                <button
                  onClick={() => setMoveVideos(filtered.filter(v => selectedIds.has(v.id)))}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-elevated"
                >
                  <Move className="h-3.5 w-3.5" /> Move
                </button>
                <button
                  onClick={() => setDeleteVideos(filtered.filter(v => selectedIds.has(v.id)))}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/10"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </button>
                <button
                  onClick={() => setSelectedIds(new Set())}
                  className="rounded-lg p-1.5 text-text-muted hover:bg-elevated hover:text-text-primary"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}

            {/* Grid */}
            {isLoading ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                {Array.from({ length: 12 }).map((_, i) => (
                  <div key={i} className="overflow-hidden rounded-xl border border-border bg-surface">
                    <div className="aspect-video animate-pulse bg-elevated" />
                    <div className="space-y-2 p-3">
                      <div className="h-3.5 animate-pulse rounded bg-elevated" />
                      <div className="h-2.5 w-1/2 animate-pulse rounded bg-elevated" />
                    </div>
                  </div>
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 text-center">
                {search ? (
                  <>
                    <Search className="mb-3 h-10 w-10 text-text-subtle" />
                    <p className="text-sm font-medium text-text-primary">No results for "{search}"</p>
                    <p className="mt-1 text-xs text-text-muted">Try a different search term</p>
                  </>
                ) : (
                  <>
                    <Film className="mb-3 h-10 w-10 text-text-subtle" />
                    <p className="text-sm font-medium text-text-primary">No videos here</p>
                    <p className="mt-1 text-xs text-text-muted">Add videos using the button above</p>
                  </>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                {filtered.map(video => (
                  <VideoCard
                    key={video.id}
                    video={video}
                    onPlay={handlePlay}
                    onRename={v => setRenameVideo(v)}
                    onDelete={v => setDeleteVideos([v])}
                    onMove={v => setMoveVideos([v])}
                    selected={selectedIds.has(video.id)}
                    onToggleSelect={toggleSelect}
                  />
                ))}
              </div>
            )}
          </div>
        </main>
      </div>

      {/* ── Overlays ─────────────────────────────────────────────────────── */}
      {nowPlaying && <Player />}
      <AddVideosModal open={showAdd} onClose={() => setShowAdd(false)} currentFolder={folder} />
      {!showAdd && <DownloadsTray onOpenModal={() => setShowAdd(true)} />}
      <StatsModal open={showStats} onClose={() => setShowStats(false)} />
      <AccountModal open={showAccount} onClose={() => setShowAccount(false)} />

      {/* Video rename */}
      <RenameModal
        open={!!renameVideo}
        onClose={() => setRenameVideo(null)}
        label={`Rename "${renameVideo?.name}"`}
        current={renameVideo?.name ?? ''}
        onConfirm={name => renameMutation.mutateAsync({ id: renameVideo!.id, name })}
      />

      {/* Video delete */}
      <ConfirmModal
        open={deleteVideos.length > 0}
        onClose={() => setDeleteVideos([])}
        title={deleteVideos.length === 1 ? `Delete "${deleteVideos[0]?.name}"?` : `Delete ${deleteVideos.length} videos?`}
        description="This cannot be undone."
        confirmLabel="Delete"
        danger
        onConfirm={() => deleteMutation.mutateAsync(deleteVideos.map(v => v.id))}
      />

      {/* Video move */}
      <MoveModal
        open={moveVideos.length > 0}
        onClose={() => setMoveVideos([])}
        title={moveVideos.length === 1 ? moveVideos[0]?.name ?? '' : `${moveVideos.length} videos`}
        onConfirm={dest => moveMutation.mutateAsync({ ids: moveVideos.map(v => v.id), dest })}
      />

      {/* Folder create */}
      <RenameModal
        open={createFolderParent !== null}
        onClose={() => setCreateFolderParent(null)}
        label={createFolderParent ? `New folder inside "${folderDisplayName(createFolderParent)}"` : 'New folder'}
        current=""
        onConfirm={name => createFolderMutation.mutateAsync({ name, parent: createFolderParent ?? '' })}
      />

      {/* Folder rename */}
      <RenameModal
        open={renameFolderPath !== null}
        onClose={() => setRenameFolderPath(null)}
        label={`Rename "${folderDisplayName(renameFolderPath ?? '')}"`}
        current={folderDisplayName(renameFolderPath ?? '')}
        onConfirm={name => renameFolderMutation.mutateAsync({ folder: renameFolderPath!, name })}
      />

      {/* Folder delete */}
      <ConfirmModal
        open={deleteFolderPath !== null}
        onClose={() => setDeleteFolderPath(null)}
        title={`Delete folder "${folderDisplayName(deleteFolderPath ?? '')}"`}
        description="All videos inside will be permanently deleted. This cannot be undone."
        confirmLabel="Delete folder"
        danger
        onConfirm={() => deleteFolderMutation.mutateAsync(deleteFolderPath!)}
      />

      {/* Folder move */}
      <MoveModal
        open={moveFolderPath !== null}
        onClose={() => setMoveFolderPath(null)}
        title={folderDisplayName(moveFolderPath ?? '')}
        excludeFolder={moveFolderPath ?? undefined}
        onConfirm={dest => moveFolderMutation.mutateAsync({ folder: moveFolderPath!, dest })}
      />
    </div>
  );
}
