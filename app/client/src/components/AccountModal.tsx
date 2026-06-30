import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Trash2, UserPlus, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { authApi, settingsApi, usersApi } from '@/api/settings';
import { AppUpdateModal } from './AppUpdateModal';

interface AccountModalProps {
  open: boolean;
  onClose: () => void;
}

export function AccountModal({ open, onClose }: AccountModalProps) {
  const qc = useQueryClient();
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: authApi.me, enabled: open });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: settingsApi.getProxy, enabled: open });
  const { data: managedUsers = [] } = useQuery({
    queryKey: ['users'],
    queryFn: usersApi.list,
    enabled: open && !!me?.isAdmin,
  });

  const [email, setEmail] = useState('');
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [proxy, setProxy] = useState('');
  const [showUpdate, setShowUpdate] = useState(false);

  // New user form
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');

  useEffect(() => { if (me) setEmail(me.email); }, [me]);
  useEffect(() => { if (settings) setProxy(settings.proxy); }, [settings]);

  const changeMutation = useMutation({
    mutationFn: () => authApi.changePassword(currentPw, email !== me?.email ? email : undefined, newPw || undefined),
    onSuccess: () => {
      toast.success('Account updated');
      setCurrentPw(''); setNewPw('');
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (err: any) => toast.error(err.response?.data?.error || 'Update failed'),
  });

  const proxyMutation = useMutation({
    mutationFn: () => settingsApi.setProxy(proxy),
    onSuccess: () => toast.success('Proxy saved — takes effect immediately'),
    onError: (err: any) => toast.error(err.response?.data?.error || 'Could not save proxy'),
  });

  const createUserMutation = useMutation({
    mutationFn: () => usersApi.create(newEmail, newPassword),
    onSuccess: () => {
      toast.success(`User ${newEmail} created`);
      setNewEmail(''); setNewPassword('');
      qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err: any) => toast.error(err.response?.data?.error || 'Could not create user'),
  });

  const deleteUserMutation = useMutation({
    mutationFn: (email: string) => usersApi.remove(email),
    onSuccess: (_, email) => {
      toast.success(`User ${email} removed`);
      qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err: any) => toast.error(err.response?.data?.error || 'Could not remove user'),
  });

  return (
    <>
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Account settings</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-6">

          {/* ── User management (admin only) ─────────────────────────── */}
          {me?.isAdmin && (
            <>
              <div className="space-y-3">
                <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-text-subtle">
                  <Users className="h-3.5 w-3.5" /> Users
                </p>

                {/* Admin row (always shown) */}
                <div className="flex items-center gap-2 rounded-lg border border-border bg-elevated px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text-primary">{me.email}</p>
                    <p className="text-[11px] text-text-muted">Admin</p>
                  </div>
                </div>

                {/* Managed users */}
                {managedUsers.map(u => (
                  <div key={u.email} className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-text-primary">{u.email}</p>
                    </div>
                    <button
                      onClick={() => deleteUserMutation.mutate(u.email)}
                      disabled={deleteUserMutation.isPending}
                      title="Remove user"
                      className="shrink-0 rounded p-1 text-text-muted hover:text-danger hover:bg-danger/10 transition-colors"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}

                {/* Add new user form */}
                <div className="rounded-xl border border-border bg-surface p-3 space-y-2">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
                    <UserPlus className="h-3.5 w-3.5" /> Add user
                  </p>
                  <Input
                    type="email"
                    value={newEmail}
                    onChange={e => setNewEmail(e.target.value)}
                    placeholder="Email address"
                    autoComplete="off"
                  />
                  <Input
                    type="password"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    placeholder="Password (min 8 characters)"
                    autoComplete="new-password"
                  />
                  <Button
                    className="w-full"
                    onClick={() => createUserMutation.mutate()}
                    disabled={!newEmail.trim() || newPassword.length < 8 || createUserMutation.isPending}
                  >
                    {createUserMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                    Create user
                  </Button>
                </div>
              </div>

              <div className="border-t border-border" />
            </>
          )}

          {/* ── Profile ────────────────────────────────────────────────── */}
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wider text-text-subtle">Profile</p>
            {me?.isAdmin && (
              <div className="space-y-1.5">
                <label className="text-xs text-text-muted">Email</label>
                <Input value={email || me?.email || ''} onChange={e => setEmail(e.target.value)} type="email" />
              </div>
            )}
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

          {me?.isAdmin && (
            <>
              <div className="border-t border-border" />

              {/* ── Proxy ──────────────────────────────────────────────── */}
              <div className="space-y-3">
                <p className="text-xs font-medium uppercase tracking-wider text-text-subtle">Network · Proxy / VPN</p>
                <p className="text-xs text-text-muted">Route yt-dlp traffic through a proxy when the server can't reach a site directly.</p>
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

              <div className="border-t border-border" />

              {/* ── App update ─────────────────────────────────────────── */}
              <div className="space-y-3">
                <p className="text-xs font-medium uppercase tracking-wider text-text-subtle">Application</p>
                <p className="text-xs text-text-muted">Pull the latest release from GitHub and rebuild. The server will restart automatically.</p>
                <Button variant="secondary" className="w-full" onClick={() => setShowUpdate(true)}>
                  Update application
                </Button>
              </div>
            </>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>

    <AppUpdateModal open={showUpdate} onClose={() => setShowUpdate(false)} />
    </>
  );
}
