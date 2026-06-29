import { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { authApi, settingsApi } from '@/api/settings';

interface AccountModalProps {
  open: boolean;
  onClose: () => void;
}

export function AccountModal({ open, onClose }: AccountModalProps) {
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: authApi.me, enabled: open });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: settingsApi.getProxy, enabled: open });

  const [email, setEmail] = useState('');
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [proxy, setProxy] = useState('');

  useEffect(() => { if (me) setEmail(me.email); }, [me]);
  useEffect(() => { if (settings) setProxy(settings.proxy); }, [settings]);

  const changeMutation = useMutation({
    mutationFn: () => authApi.changePassword(currentPw, email !== me?.email ? email : undefined, newPw || undefined),
    onSuccess: () => { toast.success('Account updated'); setCurrentPw(''); setNewPw(''); },
    onError: (err: any) => toast.error(err.response?.data?.error || 'Update failed'),
  });

  const proxyMutation = useMutation({
    mutationFn: () => settingsApi.setProxy(proxy),
    onSuccess: () => toast.success('Proxy saved — takes effect immediately'),
    onError: (err: any) => toast.error(err.response?.data?.error || 'Could not save proxy'),
  });

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Account settings</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-6">
          {/* Account */}
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wider text-text-subtle">Profile</p>
            <div className="space-y-1.5">
              <label className="text-xs text-text-muted">Email</label>
              <Input value={email || me?.email || ''} onChange={e => setEmail(e.target.value)} type="email" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-text-muted">Current password <span className="text-danger">*</span></label>
              <Input value={currentPw} onChange={e => setCurrentPw(e.target.value)} type="password" placeholder="Required to save changes" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-text-muted">New password <span className="text-text-subtle">(optional)</span></label>
              <Input value={newPw} onChange={e => setNewPw(e.target.value)} type="password" placeholder="Leave blank to keep current" />
            </div>
            <Button
              onClick={() => changeMutation.mutate()}
              disabled={!currentPw || changeMutation.isPending}
              className="w-full"
            >
              {changeMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Save changes
            </Button>
          </div>

          <div className="border-t border-border" />

          {/* Proxy */}
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wider text-text-subtle">Network · Proxy / VPN</p>
            <p className="text-xs text-text-muted">Route yt-dlp traffic through a proxy when the server can't reach a site directly. Takes effect immediately — no restart needed.</p>
            <div className="space-y-1.5">
              <label className="text-xs text-text-muted">Proxy URL</label>
              <Input
                value={proxy || settings?.proxy || ''}
                onChange={e => setProxy(e.target.value)}
                placeholder="http://host:port or socks5://127.0.0.1:1080"
                spellCheck={false}
              />
            </div>
            <Button
              variant="secondary"
              onClick={() => proxyMutation.mutate()}
              disabled={proxyMutation.isPending}
              className="w-full"
            >
              {proxyMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Save proxy
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
