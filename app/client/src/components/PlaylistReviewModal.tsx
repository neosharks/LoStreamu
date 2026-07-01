import { useEffect, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, Check, ListVideo } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from './ui/dialog';
import { downloadsApi } from '@/api/downloads';
import { formatDuration, cn } from '@/lib/utils';

interface Props {
  open: boolean;
  url: string;
  folder: string;
  onClose: () => void;
  onAdded?: () => void; // fired after items are enqueued
}

// Review modal for a playlist: lists every entry, lets the user select/deselect
// all or individually, then enqueues each selected video as its own queue item.
export function PlaylistReviewModal({ open, url, folder, onClose, onAdded }: Props) {
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const probeQuery = useQuery({
    queryKey: ['playlist-probe', url],
    queryFn: () => downloadsApi.probePlaylist(url),
    enabled: open && !!url,
    staleTime: 5 * 60_000,
  });
  const probe = probeQuery.data;

  // Select everything by default once the entries load.
  useEffect(() => {
    if (probe) setSelected(new Set(probe.entries.map(e => e.index)));
  }, [probe]);

  const addMutation = useMutation({
    mutationFn: () => {
      const items = (probe?.entries ?? [])
        .filter(e => selected.has(e.index))
        .map(e => ({ index: e.index, title: e.title, url: e.url, thumbnail: e.thumbnail }));
      return downloadsApi.startBatch({ url, folder, title: probe?.title || 'Playlist', items });
    },
    onSuccess: (data) => {
      const added = data.jobs.length;
      toast.success(`Added ${added} video${added === 1 ? '' : 's'} to the queue`
        + (data.duplicates ? ` · ${data.duplicates} already queued` : ''));
      onAdded?.();
      onClose();
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not add playlist'),
  });

  const entries = probe?.entries ?? [];
  const allSelected = entries.length > 0 && selected.size === entries.length;

  const toggle = (idx: number) => setSelected(prev => {
    const next = new Set(prev);
    next.has(idx) ? next.delete(idx) : next.add(idx);
    return next;
  });

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListVideo className="h-4 w-4 text-accent" />
            <span className="truncate">{probe?.title || 'Playlist'}</span>
          </DialogTitle>
        </DialogHeader>

        <DialogBody className="space-y-3">
          {probeQuery.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-text-muted">
              <Loader2 className="h-5 w-5 animate-spin" /> Reading playlist…
            </div>
          ) : probeQuery.isError ? (
            <p className="rounded-lg bg-danger/10 px-3 py-6 text-center text-sm text-danger">
              {(probeQuery.error as any)?.response?.data?.error || 'Could not read this playlist.'}
            </p>
          ) : entries.length === 0 ? (
            <p className="py-8 text-center text-sm text-text-muted">No videos found in this URL.</p>
          ) : (
            <>
              {/* Toolbar */}
              <div className="flex items-center gap-3 text-xs">
                <span className="text-text-muted">{selected.size}/{entries.length} selected</span>
                <button
                  onClick={() => setSelected(allSelected ? new Set() : new Set(entries.map(e => e.index)))}
                  className="font-medium text-accent hover:underline"
                >
                  {allSelected ? 'Deselect all' : 'Select all'}
                </button>
              </div>

              {/* Entry list */}
              <div className="max-h-[45vh] space-y-1 overflow-y-auto pr-1">
                {entries.map(entry => {
                  const on = selected.has(entry.index);
                  return (
                    <button
                      key={entry.index}
                      onClick={() => toggle(entry.index)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-lg border p-2 text-left transition-colors',
                        on ? 'border-accent/50 bg-accent/5' : 'border-border hover:bg-elevated',
                      )}
                    >
                      <span className={cn(
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2',
                        on ? 'border-accent bg-accent text-white' : 'border-border',
                      )}>
                        {on && <Check className="h-3 w-3" strokeWidth={3} />}
                      </span>
                      <div className="h-10 w-16 shrink-0 overflow-hidden rounded bg-elevated">
                        {entry.thumbnail && (
                          <img src={entry.thumbnail} alt="" className="h-full w-full object-cover"
                            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                        )}
                      </div>
                      <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{entry.title}</span>
                      {entry.duration ? (
                        <span className="shrink-0 text-xs tabular-nums text-text-muted">{formatDuration(entry.duration)}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              {/* Footer */}
              <div className="flex justify-end gap-2 pt-1">
                <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-medium text-text-primary hover:bg-elevated">
                  Cancel
                </button>
                <button
                  onClick={() => addMutation.mutate()}
                  disabled={!selected.size || addMutation.isPending}
                  className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
                >
                  {addMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  Add {selected.size} to queue
                </button>
              </div>
            </>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
