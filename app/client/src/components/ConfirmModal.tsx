import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from './ui/dialog';
import { Button } from './ui/button';

interface ConfirmModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
}

export function ConfirmModal({ open, onClose, title, description, confirmLabel = 'Confirm', danger, onConfirm }: ConfirmModalProps) {
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try { await onConfirm(); onClose(); } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <DialogBody className="space-y-4">
          <p className="text-sm text-text-secondary">{description}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant={danger ? 'danger' : 'default'} onClick={submit} disabled={busy}>
              {confirmLabel}
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
