import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';

interface RenameModalProps {
  open: boolean;
  onClose: () => void;
  label: string;
  current: string;
  onConfirm: (name: string) => Promise<void>;
}

export function RenameModal({ open, onClose, label, current, onConfirm }: RenameModalProps) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) setName(current); }, [open, current]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === current) { onClose(); return; }
    setBusy(true);
    try { await onConfirm(trimmed); onClose(); } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>{label}</DialogTitle></DialogHeader>
        <DialogBody className="space-y-4">
          <Input
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={submit} disabled={busy || !name.trim() || name.trim() === current}>
              {current ? 'Rename' : 'Create'}
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
