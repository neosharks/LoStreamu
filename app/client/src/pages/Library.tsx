import { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Film, Search, Move, Trash2, X, Shuffle, FolderOpen, Plus, Download, Settings,
  ListChecks, FolderPlus, ChevronRight, Layers, CornerDownRight, Home, Star, Wrench,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Sidebar } from '@/components/Sidebar';
import { VideoCard } from '@/components/VideoCard';
import { FolderCard } from '@/components/FolderCard';
import { Button } from '@/components/ui/button';
import { Player } from '@/components/Player';
import { AddVideosModal } from '@/components/AddVideosModal';
import { DownloadsTray } from '@/components/DownloadsTray';
import { RenameModal } from '@/components/RenameModal';
import { ConfirmModal } from '@/components/ConfirmModal';
import { MoveModal } from '@/components/MoveModal';
import { RepairTray, useRepairJobs } from '@/components/RepairTray';
import { FixVideosModal } from '@/components/FixVideosModal';
import { videosApi, favoritesApi, repairApi } from '@/api/videos';
import { downloadsApi } from '@/api/downloads';
import { usePlayerStore } from '@/stores/playerStore';
import { useDownloadsStore } from '@/stores/downloadsStore';
import type { DragPayload } from '@/stores/dragStore';
import { useFolderDrop } from '@/hooks/useFolderDrop';
import { cn } from '@/lib/utils';
import type { RepairOptions, Video, FolderTree } from '@/types';

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

/** Walks the folder tree to the node at `path`, or undefined if it's gone. */
function findNode(node: FolderTree | undefined, path: string): FolderTree | undefined {
  if (!node) return undefined;
  if (node.path === path) return node;
  for (const child of node.children) {
    if (path === child.path || path.startsWith(child.path + '/')) return findNode(child, path);
  }
  return undefined;
}

const SORT_KEYS: readonly SortKey[] = [
  'addedAt', 'addedAt-asc', 'name', 'name-desc', 'size', 'duration', 'random',
];
const DEFAULT_SORT: SortKey = 'random';
const randomSeed = () => Math.floor(Math.random() * 1_000_000) + 1;

export function Library() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { id: watchId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { video: nowPlaying, open: openPlayer, close: closePlayer } = usePlayerStore();
  const { hydrate, jobs, batches } = useDownloadsStore();
  const prevPlayingId = useRef<string | null>(null);

  useEffect(() => {
    Promise.all([downloadsApi.list(), downloadsApi.listBatches()])
      .then(([j, b]) => hydrate(j, b))
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── View state lives in the URL query string ────────────────────────────────
  // folder / search / sort / shuffle-seed are all encoded as search params, so a
  // refresh, a shared link, or back/forward restores the exact same view — same
  // folder, same search, same sort, and (for Shuffle) the same random order.
  const folder = searchParams.get('folder') ?? '';
  const search = searchParams.get('q') ?? '';
  const sortParam = searchParams.get('sort') as SortKey | null;
  const sort: SortKey = sortParam && SORT_KEYS.includes(sortParam) ? sortParam : DEFAULT_SORT;
  // A seed generated this render is the fallback until it's written to the URL,
  // so the first paint already shows a stable shuffle (no reorder flash).
  const fallbackSeed = useRef(randomSeed());
  const shuffleSeed = Number(searchParams.get('seed')) || fallbackSeed.current;

  // Merge a mutation into the current params. `replace` (default) keeps filter
  // tweaks out of the history stack so Back still returns to the previous page.
  const patchParams = (
    mut: (p: URLSearchParams) => void,
    opts: { replace?: boolean } = {},
  ) => {
    const next = new URLSearchParams(searchParams);
    mut(next);
    setSearchParams(next, { replace: opts.replace ?? true });
  };

  const setFolder = (f: string) =>
    patchParams(p => { f ? p.set('folder', f) : p.delete('folder'); });
  const setSearch = (q: string) =>
    patchParams(p => { q ? p.set('q', q) : p.delete('q'); });
  const setSort = (s: SortKey) =>
    patchParams(p => {
      s === DEFAULT_SORT ? p.delete('sort') : p.set('sort', s);
      // Shuffle needs a seed pinned in the URL; any other sort drops it.
      s === 'random' ? p.set('seed', String(randomSeed())) : p.delete('seed');
    });
  const reshuffle = () =>
    patchParams(p => { p.delete('sort'); p.set('seed', String(randomSeed())); });

  // The starred view is a filter over the same grid, not a separate page: every
  // selection, drag, move and player behaviour has to work there too.
  const view: 'library' | 'favorites' = searchParams.get('view') === 'favorites' ? 'favorites' : 'library';
  const setView = (next: 'library' | 'favorites') =>
    patchParams(p => {
      next === 'favorites' ? p.set('view', 'favorites') : p.delete('view');
      // Favourites span the whole library, so a folder filter would only confuse.
      if (next === 'favorites') p.delete('folder');
    });

  // Recursive by default (what the library has always shown); flip to see only
  // what sits directly in this folder, which is what makes organising legible.
  const deep = searchParams.get('deep') !== '0';
  const setDeep = (on: boolean) => patchParams(p => { on ? p.delete('deep') : p.set('deep', '0'); });

  // Pin the shuffle seed into the URL on first load so a refresh keeps the order.
  useEffect(() => {
    if (sort === 'random' && !searchParams.get('seed')) {
      patchParams(p => p.set('seed', String(fallbackSeed.current)), { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [showAdd, setShowAdd] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const isSelecting = selectedIds.size > 0;

  // Video modals
  const [renameVideo, setRenameVideo] = useState<Video | null>(null);
  const [deleteVideos, setDeleteVideos] = useState<Video[]>([]);
  const [moveVideos, setMoveVideos] = useState<Video[]>([]);
  // Non-null while the fix dialog is open. `scope` is null for a hand-picked
  // selection and the folder name when the whole folder is being fixed.
  const [fixing, setFixing] = useState<{ videos: Video[]; scope: string | null } | null>(null);

  // Folder modals
  const [createFolderParent, setCreateFolderParent] = useState<string | null>(null);
  const [renameFolderPath, setRenameFolderPath] = useState<string | null>(null);
  const [deleteFolderPath, setDeleteFolderPath] = useState<string | null>(null);
  const [moveFolderPath, setMoveFolderPath] = useState<string | null>(null);

  const { data: videos = [], isLoading } = useQuery({
    queryKey: view === 'favorites' ? ['favorites'] : ['videos', folder, deep],
    queryFn: () => (view === 'favorites' ? favoritesApi.list() : videosApi.list(folder, false, deep)),
    staleTime: 10_000,
  });

  // What the "Fix N videos" button counts. Folder-scoped, so it matches the view.
  const { data: folderHealth } = useQuery({
    queryKey: ['folder-health', folder, deep],
    queryFn: () => repairApi.folderHealth(folder, deep),
    enabled: view === 'library',
    staleTime: 30_000,
  });

  // Shared with the repair tray through the query cache — one poll, two readers.
  const { jobs: repairJobs } = useRepairJobs();
  const repairingIds = useMemo(
    () => new Set(repairJobs.filter(j => j.status === 'queued' || j.status === 'running').map(j => j.videoId)),
    [repairJobs],
  );

  // Shared with the sidebar via the query cache — one fetch, two consumers.
  const { data: tree } = useQuery({ queryKey: ['tree'], queryFn: videosApi.tree });
  const currentNode = useMemo(() => findNode(tree, folder), [tree, folder]);
  const subfolders = currentNode?.children ?? [];
  // How many videos the "this folder only" filter is hiding from view.
  const hiddenBySubfolderFilter = subfolders.reduce((n, c) => n + c.totalCount, 0);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['videos'] });
    qc.invalidateQueries({ queryKey: ['tree'] });
    qc.invalidateQueries({ queryKey: ['favorites'] });
    qc.invalidateQueries({ queryKey: ['folder-health'] });
  };

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => videosApi.rename(id, name),
    onSuccess: () => { toast.success('Renamed'); invalidate(); },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Rename failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: (ids: string[]) => videosApi.delete(ids),
    onSuccess: r => {
      if (r.failed.length) toast.warning(`Deleted ${r.deleted} · ${r.failed.length} could not be removed`);
      else toast.success(r.deleted === 1 ? 'Deleted' : `Deleted ${r.deleted} videos`);
      setSelectedIds(new Set());
      invalidate();
    },
    onError: () => toast.error('Delete failed'),
  });

  const moveMutation = useMutation({
    mutationFn: ({ ids, dest }: { ids: string[]; dest: string }) => videosApi.move(ids, dest),
    // The server reports each outcome separately: a name clash used to look
    // exactly like a successful move that did nothing.
    onSuccess: (r, { dest }) => {
      const where = dest ? `"${folderDisplayName(dest)}"` : 'the library root';
      if (r.moved) {
        const extra = r.conflicts.length ? ` · ${r.conflicts.length} skipped, name already there` : '';
        toast.success(`Moved ${r.moved} to ${where}${extra}`);
      } else if (r.conflicts.length) {
        toast.error(`Already a file called "${r.conflicts[0]}" in ${where}`);
      } else if (r.alreadyThere) {
        toast.info(`Already in ${where}`);
      } else if (r.missing) {
        toast.warning('Those videos have already moved — refreshing');
      } else {
        toast.error('Nothing was moved');
      }
      setSelectedIds(new Set());
      invalidate();
    },
    onError: () => toast.error('Move failed'),
  });

  const favoriteMutation = useMutation({
    mutationFn: (video: Video) => favoritesApi.set(video.id),
    // Flip the card straight away; the server call only confirms it.
    onMutate: async (video: Video) => {
      const keys = [['favorites'], ['videos', folder, deep]];
      const snapshots = keys.map(key => [key, qc.getQueryData<Video[]>(key)] as const);
      for (const [key] of snapshots) {
        qc.setQueryData<Video[]>(key, old => old?.map(v =>
          v.id === video.id ? { ...v, favorite: !v.favorite } : v));
      }
      return { snapshots };
    },
    onError: (_e, _video, context) => {
      for (const [key, data] of context?.snapshots ?? []) qc.setQueryData(key, data);
      toast.error('Could not update Favourites');
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['favorites'] });
      qc.invalidateQueries({ queryKey: ['videos'] });
    },
  });

  const repairMutation = useMutation({
    mutationFn: (video: Video) => repairApi.start(video.id),
    onSuccess: (_job, video) => {
      toast.success(`Fixing "${video.name}" — it runs in the background`);
      qc.invalidateQueries({ queryKey: ['repair'] });
    },
    onError: () => toast.error('Could not start the repair'),
  });

  const repairManyMutation = useMutation({
    mutationFn: ({ ids, options }: { ids: string[]; options: RepairOptions }) =>
      repairApi.startMany(ids, options),
    onSuccess: r => {
      if (r.queued) toast.success(`Fixing ${r.queued} ${r.queued === 1 ? 'video' : 'videos'}`);
      else toast.info('Nothing to fix there');
      setSelectedIds(new Set());
      qc.invalidateQueries({ queryKey: ['repair'] });
    },
    onError: () => toast.error('Could not start the repairs'),
  });

  const repairFolderMutation = useMutation({
    mutationFn: (options: RepairOptions) => repairApi.startFolder(folder, deep, options),
    onSuccess: r => {
      if (r.queued) toast.success(`Fixing ${r.queued} ${r.queued === 1 ? 'video' : 'videos'}`);
      else toast.info('Nothing here needs fixing');
      qc.invalidateQueries({ queryKey: ['repair'] });
    },
    onError: () => toast.error('Could not start the repairs'),
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

  // Anchor for shift-click ranges — the last card picked without shift.
  const anchorIndex = useRef<number | null>(null);

  const toggleSelect = (video: Video, opts?: { range?: boolean }) => {
    const index = filtered.findIndex(v => v.id === video.id);
    if (opts?.range && anchorIndex.current !== null && index >= 0) {
      const [from, to] = [anchorIndex.current, index].sort((a, b) => a - b);
      setSelectedIds(prev => {
        const next = new Set(prev);
        for (let i = from; i <= to; i++) {
          const item = filtered[i];
          if (item) next.add(item.id);
        }
        return next;
      });
      return;
    }
    anchorIndex.current = index;
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(video.id) ? next.delete(video.id) : next.add(video.id);
      return next;
    });
  };

  // Dragging a selected card takes the whole selection; dragging an unselected
  // one takes just that card, which is what every file manager does.
  const dragPayloadFor = (video: Video) => {
    const items = selectedIds.has(video.id)
      ? filtered.filter(v => selectedIds.has(v.id))
      : [video];
    return {
      ids: items.map(v => v.id),
      label: items.length === 1 ? items[0]!.name : `${items.length} videos`,
      sourceFolders: [...new Set(items.map(v => v.folder))],
    };
  };

  const handleDropInto = (payload: DragPayload, dest: string) => {
    if (payload.kind === 'videos') moveMutation.mutate({ ids: payload.ids, dest });
    else moveFolderMutation.mutate({ folder: payload.path, dest });
  };

  // Select-all operates on the CURRENT view (folder + search), so it works the
  // same inside a folder as it does across the whole library.
  const allSelected = filtered.length > 0 && filtered.every(v => selectedIds.has(v.id));
  const toggleSelectAll = () =>
    setSelectedIds(allSelected ? new Set() : new Set(filtered.map(v => v.id)));

  const handlePlay = (video: Video) => openPlayer(video, filtered);

  // ── Library keyboard shortcuts ─────────────────────────────────────────────
  // Only while the player is closed — it owns the keyboard when open.
  useEffect(() => {
    if (nowPlaying) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        toggleSelectAll();
      } else if (e.key === 'Escape' && isSelecting) {
        setSelectedIds(new Set());
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && isSelecting) {
        e.preventDefault();
        setDeleteVideos(filtered.filter(v => selectedIds.has(v.id)));
      } else if ((e.key === 'm' || e.key === 'M') && isSelecting) {
        e.preventDefault();
        setMoveVideos(filtered.filter(v => selectedIds.has(v.id)));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowPlaying, isSelecting, filtered, selectedIds]);

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

  // store → URL: reflect the playing video in the address bar; go back when
  // closed. The filter query string rides along on both hops so closing the
  // player drops the viewer back into the exact folder/search/sort they came from.
  useEffect(() => {
    const qs = searchParams.toString();
    const suffix = qs ? `?${qs}` : '';
    if (nowPlaying) {
      prevPlayingId.current = nowPlaying.id;
      if (watchId !== nowPlaying.id) navigate(`/watch/${nowPlaying.id}/${slugify(nowPlaying.name)}${suffix}`);
    } else if (prevPlayingId.current) {
      prevPlayingId.current = null;
      if (watchId) navigate({ pathname: '/', search: qs });
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
          view={view}
          onSelectView={setView}
          onSelect={f => { setView('library'); setFolder(f); setMobileSidebarOpen(false); }}
          onCreateFolder={parent => setCreateFolderParent(parent)}
          onRenameFolder={f => setRenameFolderPath(f)}
          onDeleteFolder={f => setDeleteFolderPath(f)}
          onMoveFolder={f => setMoveFolderPath(f)}
          onDropInto={handleDropInto}
          mobileOpen={mobileSidebarOpen}
          onMobileClose={() => setMobileSidebarOpen(false)}
        />

        <main className="flex-1 overflow-y-auto">
          {/* Extra bottom padding on mobile to clear the bottom nav */}
          <div className="p-4 sm:p-6 pb-24 lg:pb-6">
            {view === 'favorites' ? (
              <nav className="mb-3 flex items-center gap-2 text-sm" aria-label="View">
                <button
                  onClick={() => setView('library')}
                  className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-text-muted transition-colors hover:bg-elevated hover:text-text-primary"
                >
                  <Home className="h-3.5 w-3.5 shrink-0" /> All videos
                </button>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-subtle" />
                <span className="flex items-center gap-1.5 px-2 py-1 text-text-primary">
                  <Star className="h-3.5 w-3.5 shrink-0 text-warning" fill="currentColor" /> Favourites
                </span>
              </nav>
            ) : (
              /* Breadcrumbs — every crumb is also a drop target, so dragging a
                 file up a level is the same gesture as dragging it down one. */
              <Breadcrumbs folder={folder} onSelect={setFolder} onDropInto={handleDropInto} />
            )}

            {/* Toolbar */}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-text-primary">
                  {filtered.length} {filtered.length === 1 ? 'video' : 'videos'}
                </h2>
                {view === 'library' && (
                  <button
                    onClick={() => setCreateFolderParent(folder)}
                    title="New folder here"
                    className="flex items-center gap-1.5 rounded-lg border border-border bg-elevated px-2.5 py-1 text-xs font-medium text-text-muted transition-colors hover:bg-border hover:text-text-primary"
                  >
                    <FolderPlus className="h-3.5 w-3.5" /> New folder
                  </button>
                )}
                {view === 'library' && !!folderHealth?.total && (
                  <button
                    onClick={() => setFixing({
                      videos: filtered.filter(v => v.health && v.health.level !== 'ok'),
                      scope: folder ? folderDisplayName(folder) : 'the library',
                    })}
                    disabled={repairFolderMutation.isPending}
                    title={`${folderHealth.broken} will not play, ${folderHealth.warn} play in some browsers only`}
                    className={cn(
                      'flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50',
                      folderHealth.broken
                        ? 'border-danger/40 bg-danger/10 text-danger hover:bg-danger/20'
                        : 'border-warning/40 bg-warning/10 text-warning hover:bg-warning/20',
                    )}
                  >
                    <Wrench className="h-3.5 w-3.5" />
                    Fix {folderHealth.total} {folderHealth.total === 1 ? 'video' : 'videos'}
                  </button>
                )}
                {filtered.length > 0 && (
                  <button
                    onClick={toggleSelectAll}
                    className={cn(
                      'flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
                      allSelected
                        ? 'border-accent/40 bg-accent-light text-accent-hover'
                        : 'border-border bg-elevated text-text-muted hover:bg-border hover:text-text-primary',
                    )}
                    title={allSelected ? 'Deselect all' : 'Select all in this view'}
                  >
                    <ListChecks className="h-3.5 w-3.5" />
                    {allSelected ? 'Deselect all' : 'Select all'}
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {view === 'library' && <button
                  onClick={() => setDeep(!deep)}
                  title={deep ? 'Showing videos in subfolders too' : 'Showing only this folder'}
                  className={cn(
                    'flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
                    deep
                      ? 'border-accent/40 bg-accent-light text-accent-hover'
                      : 'border-border bg-elevated text-text-muted hover:bg-border hover:text-text-primary',
                  )}
                >
                  <Layers className="h-3.5 w-3.5" />
                  {deep ? 'Incl. subfolders' : 'This folder only'}
                </button>}
                <label className="text-xs text-text-muted">Sort</label>
                <select
                  value={sort}
                  onChange={e => setSort(e.target.value as SortKey)}
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
                    onClick={reshuffle}
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
                  <span className="ml-2 hidden text-xs font-normal text-accent-hover/60 lg:inline">
                    drag onto a folder to move · shift-click for a range
                  </span>
                </span>
                <button
                  onClick={toggleSelectAll}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-elevated"
                >
                  <ListChecks className="h-3.5 w-3.5" /> {allSelected ? 'Deselect all' : 'Select all'}
                </button>
                <button
                  onClick={() => setMoveVideos(filtered.filter(v => selectedIds.has(v.id)))}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-elevated"
                >
                  <Move className="h-3.5 w-3.5" /> Move
                </button>
                <button
                  onClick={() => setFixing({
                    videos: filtered.filter(v => selectedIds.has(v.id)),
                    scope: null,
                  })}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-elevated"
                >
                  <Wrench className="h-3.5 w-3.5" /> Fix
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

            {/* Subfolders — navigation and drop targets in one */}
            {view === 'library' && subfolders.length > 0 && (
              <div className="mb-5">
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-text-subtle">
                  Folders · {subfolders.length}
                </p>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {subfolders.map(node => (
                    <FolderCard
                      key={node.path}
                      node={node}
                      onOpen={setFolder}
                      onRename={setRenameFolderPath}
                      onDelete={setDeleteFolderPath}
                      onMove={setMoveFolderPath}
                      onNewSubfolder={setCreateFolderParent}
                      onDropInto={handleDropInto}
                    />
                  ))}
                </div>
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
                    {search ? <Search className="h-8 w-8 text-accent-hover" />
                      : view === 'favorites' ? <Star className="h-8 w-8 text-accent-hover" />
                      : <Film className="h-8 w-8 text-accent-hover" />}
                  </div>
                </div>
                {search ? (
                  <>
                    <p className="text-base font-semibold text-text-primary">No results for "{search}"</p>
                    <p className="mt-1 text-sm text-text-muted">Try a different search term</p>
                  </>
                ) : view === 'favorites' ? (
                  <>
                    <p className="text-base font-semibold text-text-primary">Nothing starred yet</p>
                    <p className="mt-1 text-sm text-text-muted">
                      Tap the star on any video and it shows up here, for your profile only.
                    </p>
                    <Button variant="secondary" className="mt-5" onClick={() => setView('library')}>
                      <Film className="h-4 w-4" /> Back to the library
                    </Button>
                  </>
                ) : !deep && hiddenBySubfolderFilter > 0 ? (
                  // Nothing sits directly here, but the subfolders are full — say
                  // so instead of claiming the library is empty.
                  <>
                    <p className="text-base font-semibold text-text-primary">
                      No videos directly in {folder ? `"${folderDisplayName(folder)}"` : 'the library root'}
                    </p>
                    <p className="mt-1 text-sm text-text-muted">
                      {hiddenBySubfolderFilter} {hiddenBySubfolderFilter === 1 ? 'video is' : 'videos are'} inside the folders above.
                    </p>
                    <Button variant="secondary" className="mt-5" onClick={() => setDeep(true)}>
                      <Layers className="h-4 w-4" /> Include subfolders
                    </Button>
                  </>
                ) : folder ? (
                  <>
                    <p className="text-base font-semibold text-text-primary">
                      Nothing in "{folderDisplayName(folder)}" yet
                    </p>
                    <p className="mt-1 text-sm text-text-muted">
                      Drag videos onto this folder to fill it.
                    </p>
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
                    selectionMode={isSelecting}
                    dragPayload={() => dragPayloadFor(video)}
                    onToggleFavorite={v => favoriteMutation.mutate(v)}
                    onFix={v => repairMutation.mutate(v)}
                    repairing={repairingIds.has(video.id)}
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
      <RepairTray />

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

      {/* Fix — bulk selection or a whole folder */}
      <FixVideosModal
        open={fixing !== null}
        onClose={() => setFixing(null)}
        videos={fixing?.videos ?? []}
        {...(fixing?.scope ? { scope: fixing.scope } : {})}
        onConfirm={options => (fixing?.scope
          ? repairFolderMutation.mutateAsync(options)
          : repairManyMutation.mutateAsync({ ids: (fixing?.videos ?? []).map(v => v.id), options }))}
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

// ── Breadcrumbs ───────────────────────────────────────────────────────────────
// The folder path as a trail of drop targets: dragging a file to a parent folder
// is the same gesture as dragging it into a child.

function Crumb({ path, label, icon: Icon, current, onSelect, onDropInto }: {
  path: string;
  label: string;
  icon?: typeof Home;
  current: boolean;
  onSelect: (p: string) => void;
  onDropInto: (payload: DragPayload, dest: string) => void;
}) {
  const drop = useFolderDrop(path, onDropInto);
  return (
    <button
      onClick={() => onSelect(path)}
      {...drop.handlers}
      className={cn(
        'flex max-w-[12rem] items-center gap-1.5 truncate rounded-lg px-2 py-1 transition-colors',
        drop.active
          ? 'bg-accent-light text-accent-hover ring-1 ring-accent/60'
          : current
          ? 'text-text-primary'
          : 'text-text-muted hover:bg-elevated hover:text-text-primary',
      )}
    >
      {drop.active
        ? <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-accent" />
        : Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
      <span className="truncate">{label}</span>
    </button>
  );
}

function Breadcrumbs({ folder, onSelect, onDropInto }: {
  folder: string;
  onSelect: (p: string) => void;
  onDropInto: (payload: DragPayload, dest: string) => void;
}) {
  const parts = folder ? folder.split('/') : [];
  return (
    <nav className="mb-3 flex flex-wrap items-center gap-0.5 text-sm" aria-label="Folder path">
      <Crumb
        path="" label="All videos" icon={Home}
        current={!folder} onSelect={onSelect} onDropInto={onDropInto}
      />
      {parts.map((part, i) => {
        const path = parts.slice(0, i + 1).join('/');
        return (
          <span key={path} className="flex items-center gap-0.5">
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-subtle" />
            <Crumb
              path={path} label={part}
              current={i === parts.length - 1}
              onSelect={onSelect} onDropInto={onDropInto}
            />
          </span>
        );
      })}
    </nav>
  );
}
