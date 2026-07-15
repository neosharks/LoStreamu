import { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Film, Search, Move, Trash2, X, Shuffle, FolderOpen, Plus, Download, Settings } from 'lucide-react';
import { Header } from '@/components/Header';
import { Sidebar } from '@/components/Sidebar';
import { VideoCard } from '@/components/VideoCard';
import { Button } from '@/components/ui/button';
import { Player } from '@/components/Player';
import { AddVideosModal } from '@/components/AddVideosModal';
import { DownloadsTray } from '@/components/DownloadsTray';
import { RenameModal } from '@/components/RenameModal';
import { ConfirmModal } from '@/components/ConfirmModal';
import { MoveModal } from '@/components/MoveModal';
import { videosApi } from '@/api/videos';
import { downloadsApi } from '@/api/downloads';
import { usePlayerStore } from '@/stores/playerStore';
import { useDownloadsStore } from '@/stores/downloadsStore';
import { cn } from '@/lib/utils';
import type { Video } from '@/types';

type SortKey = 'addedAt' | 'addedAt-asc' | 'name' | 'name-desc' | 'size' | 'duration' | 'random';

function pseudoHash(id: string, seed: number): number {
  let h = (seed * 2654435761) >>> 0;
  for (let i = 0; i < id.length; i++) h = ((h * 31) + id.charCodeAt(i)) >>> 0;
  return h;
}

// Readable URL slug from a video name, e.g. "My Clip #2" -> "my-clip-2".
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'video';
}

export function Library() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { id: watchId } = useParams();
  const { video: nowPlaying, open: openPlayer, close: closePlayer } = usePlayerStore();
  const { hydrate, jobs, batches } = useDownloadsStore();
  const prevPlayingId = useRef<string | null>(null);

  useEffect(() => {
    Promise.all([downloadsApi.list(), downloadsApi.listBatches()])
      .then(([j, b]) => hydrate(j, b))
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [folder, setFolder] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('random');
  // Fresh seed each load so the default random order differs every visit.
  const [shuffleSeed, setShuffleSeed] = useState(() => Math.floor(Math.random() * 1_000_000) + 1);
  const [showAdd, setShowAdd] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const isSelecting = selectedIds.size > 0;

  // Video modals
  const [renameVideo, setRenameVideo] = useState<Video | null>(null);
  const [deleteVideos, setDeleteVideos] = useState<Video[]>([]);
  const [moveVideos, setMoveVideos] = useState<Video[]>([]);

  // Folder modals
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
    else arr.sort((a, b) => b.addedAt - a.addedAt);
    return arr;
  }, [videos, search, sort, shuffleSeed]);

  const toggleSelect = (video: Video) =>
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(video.id) ? next.delete(video.id) : next.add(video.id);
      return next;
    });

  const handlePlay = (video: Video) => openPlayer(video, filtered);

  // ── Player ↔ URL sync ──────────────────────────────────────────────────────
  // URL → store: open the player from /watch/:id on load, refresh, or back/forward.
  useEffect(() => {
    if (!watchId) { if (nowPlaying) closePlayer(); return; }
    if (nowPlaying?.id === watchId) return;
    const found = videos.find(v => v.id === watchId);
    if (found) { openPlayer(found, filtered); return; }
    // Not in the current folder view — fetch it and build a playlist from its folder.
    videosApi.info(watchId)
      .then(v => videosApi.list(v.folder).catch(() => [] as Video[])
        .then(siblings => {
          const list = siblings.length ? siblings : [v];
          // Match the grid: default queue order is random too.
          if (sort === 'random') list.sort((a, b) => pseudoHash(a.id, shuffleSeed) - pseudoHash(b.id, shuffleSeed));
          openPlayer(v, list);
        }))
      .catch(() => navigate('/', { replace: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchId, videos]);

  // store → URL: reflect the playing video in the address bar; go back when closed.
  useEffect(() => {
    if (nowPlaying) {
      prevPlayingId.current = nowPlaying.id;
      if (watchId !== nowPlaying.id) navigate(`/watch/${nowPlaying.id}/${slugify(nowPlaying.name)}`);
    } else if (prevPlayingId.current) {
      prevPlayingId.current = null;
      if (watchId) navigate('/');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowPlaying?.id]);

  const folderDisplayName = (path: string) => path.split('/').pop() || 'root';

  // Active download count for bottom nav badge
  const activeDownloads = jobs.filter(j => !['done', 'error'].includes(j.status)).length
    + batches.filter(b => !['done', 'stopped', 'error'].includes(b.status)).length;

  const bottomNavItems = [
    {
      icon: FolderOpen,
      label: 'Folders',
      onClick: () => setMobileSidebarOpen(true),
    },
    {
      icon: Plus,
      label: 'Add',
      onClick: () => setShowAdd(true),
    },
    {
      icon: Download,
      label: 'Downloads',
      onClick: () => navigate('/downloads'),
      badge: activeDownloads,
    },
    {
      icon: Settings,
      label: 'Settings',
      onClick: () => navigate('/settings'),
    },
  ];

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header
        onAddVideos={() => setShowAdd(true)}
        videoCount={videos.length}
        search={search}
        onSearch={setSearch}
      />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          selected={folder}
          onSelect={f => { setFolder(f); setMobileSidebarOpen(false); }}
          onCreateFolder={parent => setCreateFolderParent(parent)}
          onRenameFolder={f => setRenameFolderPath(f)}
          onDeleteFolder={f => setDeleteFolderPath(f)}
          onMoveFolder={f => setMoveFolderPath(f)}
          mobileOpen={mobileSidebarOpen}
          onMobileClose={() => setMobileSidebarOpen(false)}
        />

        <main className="flex-1 overflow-y-auto">
          {/* Extra bottom padding on mobile to clear the bottom nav */}
          <div className="p-4 sm:p-6 pb-24 lg:pb-6">
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
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {Array.from({ length: 12 }).map((_, i) => (
                  <div key={i} className="overflow-hidden rounded-xl border border-border bg-surface">
                    <div className="skeleton aspect-video animate-shimmer" />
                    <div className="space-y-2 p-3">
                      <div className="skeleton h-3.5 animate-shimmer rounded" />
                      <div className="skeleton h-2.5 w-1/2 animate-shimmer rounded" />
                    </div>
                  </div>
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex animate-pop-in flex-col items-center justify-center py-24 text-center">
                <div className="relative mb-5 flex h-20 w-20 items-center justify-center">
                  <span className="brand-glow absolute inset-0 animate-glow-pulse rounded-full blur-lg" />
                  <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-surface">
                    {search
                      ? <Search className="h-8 w-8 text-accent-hover" />
                      : <Film className="h-8 w-8 text-accent-hover" />}
                  </div>
                </div>
                {search ? (
                  <>
                    <p className="text-base font-semibold text-text-primary">No results for "{search}"</p>
                    <p className="mt-1 text-sm text-text-muted">Try a different search term</p>
                  </>
                ) : (
                  <>
                    <p className="text-base font-semibold text-text-primary">Your library is empty</p>
                    <p className="mt-1 text-sm text-text-muted">Paste a link and LoStreamu pulls it in for offline viewing.</p>
                    <Button className="mt-5" onClick={() => setShowAdd(true)}>
                      <Plus className="h-4 w-4" /> Add your first video
                    </Button>
                  </>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {filtered.map((video, i) => (
                  <VideoCard
                    key={video.id}
                    index={i}
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

      {/* ── Mobile bottom nav ──────────────────────────────────────────── */}
      <nav
        className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 backdrop-blur-md lg:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        <div className="flex h-16 items-center justify-around px-2">
          {bottomNavItems.map(({ icon: Icon, label, onClick, badge }) => (
            <button
              key={label}
              onClick={onClick}
              className="flex flex-col items-center gap-1 rounded-xl px-4 py-2 text-text-muted transition-colors hover:text-text-primary active:bg-elevated"
            >
              <div className="relative">
                <Icon className="h-5 w-5" />
                {badge != null && badge > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-[9px] font-bold text-white">
                    {badge > 9 ? '9+' : badge}
                  </span>
                )}
              </div>
              <span className="text-[10px] font-medium leading-none">{label}</span>
            </button>
          ))}
        </div>
      </nav>

      {/* ── Overlays ─────────────────────────────────────────────────────── */}
      {nowPlaying && <Player />}
      <AddVideosModal open={showAdd} onClose={() => setShowAdd(false)} currentFolder={folder} />
      {!showAdd && <DownloadsTray onOpenModal={() => setShowAdd(true)} />}

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
