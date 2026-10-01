import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Users, ScanFace, Loader2, Pencil, Trash2, Merge, X, ChevronLeft, Square, CheckSquare,
  RotateCcw, Film,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/button';
import { VideoCard } from '@/components/VideoCard';
import { Player } from '@/components/Player';
import { AddVideosModal } from '@/components/AddVideosModal';
import { RenameModal } from '@/components/RenameModal';
import { ConfirmModal } from '@/components/ConfirmModal';
import { facesApi, faceThumbUrl } from '@/api/faces';
import { favoritesApi } from '@/api/videos';
import { usePlayerStore } from '@/stores/playerStore';
import { cn } from '@/lib/utils';
import type { Person, Video } from '@/types';

// ── People ────────────────────────────────────────────────────────────────────
// Everyone the face scan has found, as a wall of faces. Tapping one shows every
// video they appear in.
//
// Clustering is tuned to split rather than merge (see services/faces/store.ts),
// so the same person turning up twice is expected and the fix is a click: tick
// both, press Merge. Nothing here runs a scan on its own — scanning a library is
// hours of CPU, so it only ever starts because someone asked for it.

const POLL_MS = 2000;

function displayName(person: Person, index: number): string {
  return person.name || `Person ${index + 1}`;
}

export function People() {
  const { personId } = useParams();
  return personId ? <PersonDetail personId={personId} /> : <PeopleGrid />;
}

// ── The wall of faces ─────────────────────────────────────────────────────────

function PeopleGrid() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<{ person: Person; label: string } | null>(null);
  const [removing, setRemoving] = useState<{ person: Person; label: string } | null>(null);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const { data: status } = useQuery({
    queryKey: ['faces-status'],
    queryFn: facesApi.status,
    refetchInterval: query => (query.state.data?.running ? POLL_MS : false),
  });
  const { data: people = [], isLoading } = useQuery({
    queryKey: ['faces-people'],
    queryFn: facesApi.people,
  });

  // People appear as the scan finds them, so keep the wall in step while it runs.
  useEffect(() => {
    if (status?.running) qc.invalidateQueries({ queryKey: ['faces-people'] });
  }, [status?.done, status?.running, qc]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['faces-people'] });
    qc.invalidateQueries({ queryKey: ['faces-status'] });
  };

  const scanMutation = useMutation({
    mutationFn: (force: boolean) => facesApi.scan({ force }),
    onSuccess: s => {
      toast.success(s.total ? `Scanning ${s.total} ${s.total === 1 ? 'video' : 'videos'}` : 'Everything is already scanned');
      refresh();
    },
    onError: () => toast.error('Could not start the scan'),
  });

  const stopMutation = useMutation({
    mutationFn: facesApi.stop,
    onSuccess: () => { toast.info('Scan stopped'); refresh(); },
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => facesApi.rename(id, name),
    onSuccess: () => { toast.success('Renamed'); refresh(); },
    onError: () => toast.error('Rename failed'),
  });

  const mergeMutation = useMutation({
    mutationFn: ({ target, sources }: { target: string; sources: string[] }) => facesApi.merge(target, sources),
    onSuccess: () => { toast.success('Merged into one person'); setPicked(new Set()); refresh(); },
    onError: () => toast.error('Merge failed'),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => facesApi.remove(id),
    onSuccess: () => { toast.success('Removed'); refresh(); },
    onError: () => toast.error('Could not remove them'),
  });

  const resetMutation = useMutation({
    mutationFn: facesApi.reset,
    onSuccess: () => { toast.success('Face index cleared'); setPicked(new Set()); refresh(); },
    onError: () => toast.error('Could not clear the index'),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return people;
    return people.filter((p, i) => displayName(p, i).toLowerCase().includes(q));
  }, [people, search]);

  const togglePick = (id: string) =>
    setPicked(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // Merging keeps whoever appears in the most videos — the best-established
  // centroid wins, so the merged person keeps matching future faces well.
  const mergeTarget = useMemo(() => {
    const chosen = people.filter(p => picked.has(p.id));
    return chosen.length > 1 ? chosen.reduce((a, b) => (b.videoCount > a.videoCount ? b : a)) : null;
  }, [people, picked]);

  const running = !!status?.running;
  const unscanned = status ? Math.max(0, status.library - status.indexed) : 0;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header
        onAddVideos={() => setShowAdd(true)}
        videoCount={status?.library ?? 0}
        search={search}
        onSearch={setSearch}
      />

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl p-4 pb-24 sm:p-6 lg:pb-6">
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <button
              onClick={() => navigate('/')}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-elevated px-2.5 py-1 text-xs font-medium text-text-muted transition-colors hover:bg-border hover:text-text-primary"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Library
            </button>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <Users className="h-5 w-5 text-accent" /> People
            </h1>
            <span className="text-sm text-text-muted">
              {people.length} found · {status?.indexed ?? 0} of {status?.library ?? 0} videos scanned
            </span>
          </div>

          <ScanPanel
            running={running}
            unscanned={unscanned}
            status={status}
            onScan={() => scanMutation.mutate(false)}
            onRescan={() => scanMutation.mutate(true)}
            onStop={() => stopMutation.mutate()}
            onReset={() => setConfirmReset(true)}
            busy={scanMutation.isPending}
            hasIndex={people.length > 0 || (status?.indexed ?? 0) > 0}
          />

          {picked.size > 0 && (
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-accent/30 bg-accent-light px-4 py-2.5">
              <span className="flex-1 text-sm font-medium text-accent-hover">
                {picked.size} selected
                {mergeTarget && (
                  <span className="ml-2 text-xs font-normal text-accent-hover/70">
                    merging keeps "{displayName(mergeTarget, people.indexOf(mergeTarget))}"
                  </span>
                )}
              </span>
              <button
                onClick={() => setConfirmMerge(true)}
                disabled={picked.size < 2}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-elevated disabled:opacity-40"
              >
                <Merge className="h-3.5 w-3.5" /> Merge into one
              </button>
              <button
                onClick={() => setPicked(new Set())}
                className="rounded-lg p-1.5 text-text-muted hover:bg-elevated hover:text-text-primary"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {isLoading ? (
            <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8">
              {Array.from({ length: 16 }).map((_, i) => (
                <div key={i} className="space-y-2">
                  <div className="skeleton aspect-square animate-shimmer rounded-full" />
                  <div className="skeleton mx-auto h-3 w-3/4 animate-shimmer rounded" />
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyPeople search={search} running={running} scanned={status?.indexed ?? 0} />
          ) : (
            <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8">
              {filtered.map(person => {
                const index = people.indexOf(person);
                const label = displayName(person, index);
                return (
                  <PersonTile
                    key={person.id}
                    person={person}
                    label={label}
                    picked={picked.has(person.id)}
                    onOpen={() => navigate(`/people/${person.id}`)}
                    onPick={() => togglePick(person.id)}
                    onRename={() => setRenaming({ person, label })}
                    onRemove={() => setRemoving({ person, label })}
                  />
                );
              })}
            </div>
          )}
        </div>
      </main>

      <AddVideosModal open={showAdd} onClose={() => setShowAdd(false)} currentFolder="" />

      <RenameModal
        open={!!renaming}
        onClose={() => setRenaming(null)}
        label={`Name this person (currently "${renaming?.label}")`}
        current={renaming?.person.name ?? ''}
        confirmLabel="Save name"
        onConfirm={name => renameMutation.mutateAsync({ id: renaming!.person.id, name })}
      />

      <ConfirmModal
        open={confirmMerge}
        onClose={() => setConfirmMerge(false)}
        title={`Merge ${picked.size} people into one?`}
        description={mergeTarget
          ? `They all become "${displayName(mergeTarget, people.indexOf(mergeTarget))}". Use this when the scan split one person across several tiles.`
          : 'Pick at least two.'}
        confirmLabel="Merge"
        onConfirm={async () => {
          if (!mergeTarget) return;
          await mergeMutation.mutateAsync({
            target: mergeTarget.id,
            sources: [...picked].filter(id => id !== mergeTarget.id),
          });
          setConfirmMerge(false);
        }}
      />

      <ConfirmModal
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={`Remove "${removing?.label}"?`}
        description="They disappear from People. No videos are deleted, and the next scan may find them again."
        confirmLabel="Remove"
        danger
        onConfirm={() => removeMutation.mutateAsync(removing!.person.id)}
      />

      <ConfirmModal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Clear the whole face index?"
        description="Every person and every name goes, and the library has to be scanned again from scratch. No videos are touched."
        confirmLabel="Clear index"
        danger
        onConfirm={() => resetMutation.mutateAsync()}
      />
    </div>
  );
}

// ── Scan controls ─────────────────────────────────────────────────────────────

function ScanPanel({ running, unscanned, status, onScan, onRescan, onStop, onReset, busy, hasIndex }: {
  running: boolean;
  unscanned: number;
  status: { done: number; total: number; current?: string; modelProgress?: number; error?: string; model: string } | undefined;
  onScan: () => void;
  onRescan: () => void;
  onStop: () => void;
  onReset: () => void;
  busy: boolean;
  hasIndex: boolean;
}) {
  const percent = status && status.total ? Math.round((status.done / status.total) * 100) : 0;

  return (
    <div className="mb-5 rounded-xl border border-border bg-surface p-4">
      {running ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />
            <p className="flex-1 truncate text-sm font-medium text-text-primary">
              {status?.modelProgress !== undefined
                ? `Downloading the face models… ${status.modelProgress}%`
                : `Scanning ${status?.done ?? 0} of ${status?.total ?? 0}${status?.current ? ` · ${status.current}` : ''}`}
            </p>
            <Button size="sm" variant="secondary" onClick={onStop}>Stop</Button>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
            <div
              className="h-full rounded-full bg-accent transition-all"
              style={{ width: `${status?.modelProgress ?? percent}%` }}
            />
          </div>
          <p className="text-xs text-text-subtle">
            This runs at low priority, so watching something stays smooth. You can leave this page.
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <ScanFace className="h-5 w-5 shrink-0 text-accent" />
          <p className="flex-1 text-sm text-text-muted">
            {unscanned > 0
              ? `${unscanned} ${unscanned === 1 ? 'video has' : 'videos have'} not been scanned for faces yet.`
              : 'Every video has been scanned. New downloads need another run.'}
          </p>
          {status?.error && <p className="w-full text-xs text-danger">{status.error}</p>}
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={onScan} disabled={busy}>
              <ScanFace className="h-4 w-4" /> {unscanned > 0 ? `Scan ${unscanned}` : 'Scan for faces'}
            </Button>
            {hasIndex && (
              <>
                <Button size="sm" variant="secondary" onClick={onRescan} disabled={busy} title="Scan every video again">
                  <RotateCcw className="h-4 w-4" /> Rescan all
                </Button>
                <Button size="sm" variant="ghost" onClick={onReset} className="text-danger hover:bg-danger/10">
                  <Trash2 className="h-4 w-4" /> Clear
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PersonTile({ person, label, picked, onOpen, onPick, onRename, onRemove }: {
  person: Person;
  label: string;
  picked: boolean;
  onOpen: () => void;
  onPick: () => void;
  onRename: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="group relative flex flex-col items-center gap-2 animate-fade-up">
      <button
        onClick={onOpen}
        title={`${label} — ${person.videoCount} ${person.videoCount === 1 ? 'video' : 'videos'}`}
        className={cn(
          'relative aspect-square w-full overflow-hidden rounded-full border-2 bg-elevated transition-all duration-200 hover:-translate-y-1 hover:shadow-xl hover:shadow-accent/10',
          picked ? 'border-accent ring-2 ring-accent/30' : 'border-border hover:border-accent/60',
        )}
      >
        <img
          src={faceThumbUrl(person.cover)}
          alt={label}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
      </button>

      <button
        onClick={onPick}
        title={picked ? 'Deselect' : 'Select — tick two to merge them'}
        className={cn(
          'absolute left-0 top-0 rounded-md bg-black/50 p-1 transition-opacity',
          picked ? 'text-accent opacity-100' : 'text-white/80 opacity-0 group-hover:opacity-100 focus:opacity-100',
        )}
      >
        {picked ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
      </button>

      <div className="absolute right-0 top-0 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button
          onClick={onRename}
          title="Name this person"
          className="rounded-md bg-black/50 p-1 text-white/80 transition-colors hover:bg-black/70 hover:text-white"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={onRemove}
          title="Remove from People"
          className="rounded-md bg-black/50 p-1 text-white/80 transition-colors hover:bg-danger/80 hover:text-white"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="w-full text-center">
        <p className={cn('truncate text-xs font-medium', person.name ? 'text-text-primary' : 'text-text-muted')}>
          {label}
        </p>
        <p className="text-[11px] text-text-subtle">
          {person.videoCount} {person.videoCount === 1 ? 'video' : 'videos'}
        </p>
      </div>
    </div>
  );
}

function EmptyPeople({ search, running, scanned }: { search: string; running: boolean; scanned: number }) {
  return (
    <div className="flex animate-pop-in flex-col items-center justify-center py-20 text-center">
      <div className="relative mb-5 flex h-20 w-20 items-center justify-center">
        <span className="brand-glow absolute inset-0 animate-glow-pulse rounded-full blur-lg" />
        <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-surface">
          <Users className="h-8 w-8 text-accent-hover" />
        </div>
      </div>
      {search ? (
        <>
          <p className="text-base font-semibold text-text-primary">Nobody called "{search}"</p>
          <p className="mt-1 text-sm text-text-muted">Only people you have named can be searched.</p>
        </>
      ) : running ? (
        <>
          <p className="text-base font-semibold text-text-primary">Looking for faces…</p>
          <p className="mt-1 text-sm text-text-muted">People appear here as they are found.</p>
        </>
      ) : scanned > 0 ? (
        <>
          <p className="text-base font-semibold text-text-primary">No faces found yet</p>
          <p className="mt-1 text-sm text-text-muted">
            The videos scanned so far had no clear, front-facing shots to work from.
          </p>
        </>
      ) : (
        <>
          <p className="text-base font-semibold text-text-primary">No one has been scanned for yet</p>
          <p className="mt-1 max-w-md text-sm text-text-muted">
            Run a scan and LoStreamu samples frames from each video, groups the faces it finds,
            and lists everyone here. The first run also downloads the face models.
          </p>
        </>
      )}
    </div>
  );
}

// ── One person's videos ───────────────────────────────────────────────────────

function PersonDetail({ personId }: { personId: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const { video: nowPlaying, open: openPlayer } = usePlayerStore();

  const { data: people = [] } = useQuery({ queryKey: ['faces-people'], queryFn: facesApi.people });
  const { data: videos = [], isLoading } = useQuery({
    queryKey: ['faces-videos', personId],
    queryFn: () => facesApi.videos(personId),
  });

  const person = people.find(p => p.id === personId);
  const label = person ? displayName(person, people.indexOf(person)) : 'Person';

  const renameMutation = useMutation({
    mutationFn: (name: string) => facesApi.rename(personId, name),
    onSuccess: () => { toast.success('Renamed'); qc.invalidateQueries({ queryKey: ['faces-people'] }); },
    onError: () => toast.error('Rename failed'),
  });

  const favoriteMutation = useMutation({
    mutationFn: (v: Video) => favoritesApi.set(v.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['faces-videos', personId] });
      qc.invalidateQueries({ queryKey: ['favorites'] });
      qc.invalidateQueries({ queryKey: ['videos'] });
    },
    onError: () => toast.error('Could not update Favourites'),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? videos.filter(v => v.name.toLowerCase().includes(q)) : videos;
  }, [videos, search]);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header
        onAddVideos={() => setShowAdd(true)}
        videoCount={videos.length}
        search={search}
        onSearch={setSearch}
      />

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl p-4 pb-24 sm:p-6 lg:pb-6">
          <div className="mb-5 flex items-center gap-3">
            <button
              onClick={() => navigate('/people')}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-elevated px-2.5 py-1 text-xs font-medium text-text-muted transition-colors hover:bg-border hover:text-text-primary"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> People
            </button>
            {person && (
              <img
                src={faceThumbUrl(person.cover)}
                alt={label}
                className="h-12 w-12 shrink-0 rounded-full border border-border object-cover"
              />
            )}
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-lg font-semibold text-text-primary">{label}</h1>
              <p className="text-sm text-text-muted">
                {videos.length} {videos.length === 1 ? 'video' : 'videos'}
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setRenaming(true)}>
              <Pencil className="h-4 w-4" /> {person?.name ? 'Rename' : 'Give them a name'}
            </Button>
          </div>

          {isLoading ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="overflow-hidden rounded-xl border border-border bg-surface">
                  <div className="skeleton aspect-video animate-shimmer" />
                  <div className="space-y-2 p-3">
                    <div className="skeleton h-3.5 animate-shimmer rounded" />
                  </div>
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <Film className="mb-3 h-10 w-10 text-text-subtle" />
              <p className="text-base font-semibold text-text-primary">
                {search ? `No results for "${search}"` : 'Nothing here any more'}
              </p>
              <p className="mt-1 text-sm text-text-muted">
                {search ? 'Try a different search term' : 'Their videos may have been deleted or moved.'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {filtered.map((video, i) => (
                <VideoCard
                  key={video.id}
                  index={i}
                  video={video}
                  onPlay={v => openPlayer(v, filtered)}
                  onRename={() => toast.info('Rename videos from the library')}
                  onDelete={() => toast.info('Delete videos from the library')}
                  onMove={() => toast.info('Move videos from the library')}
                  onToggleFavorite={v => favoriteMutation.mutate(v)}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      {nowPlaying && <Player />}
      <AddVideosModal open={showAdd} onClose={() => setShowAdd(false)} currentFolder="" />

      <RenameModal
        open={renaming}
        onClose={() => setRenaming(false)}
        label={`Name this person (currently "${label}")`}
        current={person?.name ?? ''}
        confirmLabel="Save name"
        onConfirm={name => renameMutation.mutateAsync(name)}
      />
    </div>
  );
}
