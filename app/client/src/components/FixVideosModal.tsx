import { useState, useEffect } from 'react';
import { Wrench, AlertTriangle, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from './ui/dialog';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';
import type { RepairOptions, Video } from '@/types';

// Confirmation for repairing a batch. It exists for one reason: the option to
// delete whatever cannot be rebuilt is destructive and irreversible, so it has
// to be chosen deliberately and described plainly, every time — never remembered
// and never on by default.

interface FixVideosModalProps {
  open: boolean;
  onClose: () => void;
  /** Already filtered to what will actually be repaired. */
  videos: Video[];
  /** Where the list came from, for the wording. */
  scope?: string;
  onConfirm: (options: RepairOptions) => Promise<unknown>;
}

export function FixVideosModal({ open, onClose, videos, scope, onConfirm }: FixVideosModalProps) {
  const [deleteIfUnfixable, setDeleteIfUnfixable] = useState(false);
  const [busy, setBusy] = useState(false);

  // Never carry the destructive choice over from a previous batch.
  useEffect(() => { if (open) setDeleteIfUnfixable(false); }, [open]);

  const transcodes = videos.filter(v => v.health?.plan === 'transcode').length;
  const remuxes = videos.filter(v => v.health?.plan === 'remux').length;
  const unknown = videos.length - transcodes - remuxes;

  const submit = async () => {
    setBusy(true);
    try { await onConfirm({ deleteIfUnfixable }); onClose(); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            Fix {videos.length} {videos.length === 1 ? 'video' : 'videos'}
            {scope ? ` in ${scope}` : ''}?
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="space-y-1.5 text-sm text-text-secondary">
            {remuxes > 0 && (
              <p>
                <span className="font-medium text-text-primary">{remuxes}</span> can be repacked —
                seconds each, and nothing is re-encoded.
              </p>
            )}
            {transcodes > 0 && (
              <p>
                <span className="font-medium text-text-primary">{transcodes}</span> need re-encoding,
                which is slow on a small server. They run one at a time in the background and you can
                keep watching meanwhile.
              </p>
            )}
            {unknown > 0 && (
              <p>
                <span className="font-medium text-text-primary">{unknown}</span> have not been checked
                yet and will be repacked.
              </p>
            )}
            <p className="text-text-muted">
              Each original is kept until its replacement has been checked and found playable.
            </p>
          </div>

          <button
            type="button"
            onClick={() => setDeleteIfUnfixable(v => !v)}
            className={cn(
              'flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors',
              deleteIfUnfixable
                ? 'border-danger/50 bg-danger/10'
                : 'border-border bg-elevated hover:border-danger/30',
            )}
          >
            <span className={cn(
              'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition-colors',
              deleteIfUnfixable ? 'border-danger bg-danger text-white' : 'border-text-subtle',
            )}>
              {deleteIfUnfixable && <Trash2 className="h-3 w-3" />}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-text-primary">
                Delete the ones that cannot be fixed
              </span>
              <span className="mt-0.5 block text-xs text-text-muted">
                A video whose rebuild fails is removed for good. A repair can also fail for reasons
                that are nothing to do with the file — a full disk, or a restart mid-encode — so
                leave this off unless you want the unplayable ones gone.
              </span>
            </span>
          </button>

          {deleteIfUnfixable && (
            <p className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Anything that fails will be deleted permanently. This cannot be undone.
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button
              variant={deleteIfUnfixable ? 'danger' : 'default'}
              onClick={submit}
              disabled={busy || videos.length === 0}
            >
              <Wrench className="h-4 w-4" />
              {deleteIfUnfixable ? 'Fix, deleting failures' : 'Fix them'}
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
