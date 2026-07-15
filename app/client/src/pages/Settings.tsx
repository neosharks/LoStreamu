import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ChevronLeft, User, Users, Wifi, Package, RefreshCw, LogOut,
  Loader2, Trash2, UserPlus, Sparkles, Image as ImageIcon, Wrench,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { authApi, settingsApi, usersApi } from '@/api/settings';
import { videosApi } from '@/api/videos';
import { AppUpdateModal } from '@/components/AppUpdateModal';
import { formatBytes } from '@/lib/utils';

export function Settings() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: me } = useQuery({ queryKey: ['me'], queryFn: authApi.me });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: settingsApi.getProxy });
  const { data: managedUsers = [] } = useQuery({
    queryKey: ['users'],
    queryFn: usersApi.list,
    enabled: !!me?.isAdmin,
  });
  const { data: appVersion } = useQuery({
    queryKey: ['app-version'],
    queryFn: settingsApi.appVersion,
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
  const { data: ytdlp } = useQuery({
    queryKey: ['ytdlp-version'],
    queryFn: settingsApi.ytdlpVersion,
    enabled: !!me?.isAdmin,
    retry: false,
  });

  const [email, setEmail] = useState('');
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [proxy, setProxy] = useState('');
  const [showUpdate, setShowUpdate] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');

  useEffect(() => { if (me) setEmail(me.email); }, [me]);
  useEffect(() => { if (settings) setProxy(settings.proxy ?? ''); }, [settings]);

  const changeMutation = useMutation({
    mutationFn: () => authApi.changePassword(currentPw, email !== me?.email ? email : undefined, newPw || undefined),
    onSuccess: () => {
      toast.success('Account updated');
      setCurrentPw('');
      setNewPw('');
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
      setNewEmail('');
      setNewPassword('');
      qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err: any) => toast.error(err.response?.data?.error || 'Could not create user'),
  });

  const deleteUserMutation = useMutation({
    mutationFn: (em: string) => usersApi.remove(em),
    onSuccess: (_, em) => {
      toast.success(`User ${em} removed`);
      qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err: any) => toast.error(err.response?.data?.error || 'Could not remove user'),
  });

  const rescanMutation = useMutation({
    mutationFn: videosApi.rescan,
    onSuccess: (data) => {
      toast.success(`Library rescanned — ${data.count} videos`);
      qc.invalidateQueries({ queryKey: ['videos'] });
      qc.invalidateQueries({ queryKey: ['tree'] });
    },
  });

  const cleanMutation = useMutation({
    mutationFn: settingsApi.cleanJunk,
    onSuccess: (r) => {
      toast.success(
        r.removedFiles
          ? `Cleaned ${r.removedFiles} file${r.removedFiles === 1 ? '' : 's'} · freed ${formatBytes(r.freedBytes)}`
          : 'Already clean — nothing to remove',
      );
      qc.invalidateQueries({ queryKey: ['videos'] });
      qc.invalidateQueries({ queryKey: ['tree'] });
    },
    onError: (err: any) => toast.error(err.response?.data?.error || 'Cleanup failed'),
  });

  const regenMutation = useMutation({
    mutationFn: settingsApi.regenerateThumbnails,
    onSuccess: (r) => {
      const parts = [`${r.generated} generated`];
      if (r.skipped) parts.push(`${r.skipped} already ok`);
      if (r.failed) parts.push(`${r.failed} failed`);
      const msg = `Thumbnails: ${parts.join(' · ')} (of ${r.total})`;
      r.failed ? toast.warning(msg) : toast.success(msg);
      qc.invalidateQueries({ queryKey: ['videos'] });
    },
    onError: (err: any) => toast.error(err.response?.data?.error || 'Thumbnail regeneration failed'),
  });

  const ytdlpUpdateMutation = useMutation({
    mutationFn: settingsApi.ytdlpUpdate,
    onSuccess: (data) => {
      toast.success(`yt-dlp updated to ${data.version}`);
      qc.invalidateQueries({ queryKey: ['ytdlp-version'] });
    },
    onError: (err: any) => toast.error(err.response?.data?.error || 'yt-dlp update failed'),
  });

  const logoutMutation = useMutation({
    mutationFn: authApi.logout,
    onSuccess: () => { window.location.href = '/login'; },
  });

  return (
    <>
      <div className="flex h-screen flex-col overflow-hidden bg-bg">
        <header
          className="glass sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border px-4 pt-safe"
          style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
        >
          <button
            onClick={() => navigate(-1)}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-text-muted hover:bg-elevated hover:text-text-primary transition-colors"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <h1 className="text-sm font-semibold text-text-primary">Settings</h1>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div
            className="mx-auto max-w-2xl space-y-4 px-4 py-6"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1.5rem)' }}
          >

            {/* ── Profile ─────────────────────────────────────────────── */}
            <section className="overflow-hidden rounded-2xl border border-border bg-surface">
              <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
                <User className="h-4 w-4 text-text-muted" />
                <h2 className="text-sm font-semibold text-text-primary">Profile</h2>
              </div>
              <div className="space-y-3 p-5">
                {me?.isAdmin && (
                  <div className="space-y-1.5">
                    <label className="text-xs text-text-muted">Email</label>
                    <Input value={email || me?.email || ''} onChange={e => setEmail(e.target.value)} type="email" />
                  </div>
                )}
                <div className="space-y-1.5">
                  <label className="text-xs text-text-muted">
                    Current password <span className="text-danger">*</span>
                  </label>
                  <Input value={currentPw} onChange={e => setCurrentPw(e.target.value)} type="password" placeholder="Required to save" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-text-muted">
                    New password <span className="text-text-subtle">(optional)</span>
                  </label>
                  <Input value={newPw} onChange={e => setNewPw(e.target.value)} type="password" placeholder="Leave blank to keep current" />
                </div>
                <Button onClick={() => changeMutation.mutate()} disabled={!currentPw || changeMutation.isPending} className="w-full">
                  {changeMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  Save changes
                </Button>
              </div>
            </section>

            {/* ── Users (admin) ───────────────────────────────────────── */}
            {me?.isAdmin && (
              <section className="overflow-hidden rounded-2xl border border-border bg-surface">
                <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
                  <Users className="h-4 w-4 text-text-muted" />
                  <h2 className="text-sm font-semibold text-text-primary">Users</h2>
                </div>
                <div className="space-y-2 p-5">
                  <div className="flex items-center gap-2 rounded-lg border border-border bg-elevated px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-text-primary">{me.email}</p>
                      <p className="text-[11px] text-text-muted">Admin</p>
                    </div>
                  </div>
                  {managedUsers.map(u => (
                    <div key={u.email} className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-text-primary">{u.email}</p>
                      </div>
                      <button
                        onClick={() => deleteUserMutation.mutate(u.email)}
                        disabled={deleteUserMutation.isPending}
                        className="shrink-0 rounded p-1.5 text-text-muted hover:text-danger hover:bg-danger/10 transition-colors"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                  <div className="mt-3 rounded-xl border border-border bg-elevated/50 p-3 space-y-2">
                    <p className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
                      <UserPlus className="h-3.5 w-3.5" /> Add user
                    </p>
                    <Input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder="Email address" autoComplete="off" />
                    <Input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="Password (min 8 chars)" autoComplete="new-password" />
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
              </section>
            )}

            {/* ── Network (admin) ─────────────────────────────────────── */}
            {me?.isAdmin && (
              <section className="overflow-hidden rounded-2xl border border-border bg-surface">
                <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
                  <Wifi className="h-4 w-4 text-text-muted" />
                  <h2 className="text-sm font-semibold text-text-primary">Network · Proxy / VPN</h2>
                </div>
                <div className="space-y-3 p-5">
                  <p className="text-xs text-text-muted">
                    Route yt-dlp traffic through a proxy when the server can't reach a site directly.
                  </p>
                  <div className="space-y-1.5">
                    <label className="text-xs text-text-muted">Proxy URL</label>
                    <Input
                      value={proxy}
                      onChange={e => setProxy(e.target.value)}
                      placeholder="http://host:port or socks5://127.0.0.1:1080"
                      spellCheck={false}
                    />
                  </div>
                  <Button variant="secondary" onClick={() => proxyMutation.mutate()} disabled={proxyMutation.isPending} className="w-full">
                    {proxyMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                    Save proxy
                  </Button>
                </div>
              </section>
            )}

            {/* ── Library ─────────────────────────────────────────────── */}
            <section className="overflow-hidden rounded-2xl border border-border bg-surface">
              <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
                <RefreshCw className="h-4 w-4 text-text-muted" />
                <h2 className="text-sm font-semibold text-text-primary">Library</h2>
              </div>
              <div className="space-y-3 p-5">
                <p className="text-xs text-text-muted">
                  Force a rescan of the media directory to pick up files added externally.
                </p>
                <Button variant="secondary" onClick={() => rescanMutation.mutate()} disabled={rescanMutation.isPending} className="w-full">
                  {rescanMutation.isPending
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <RefreshCw className="h-4 w-4" />}
                  Rescan
                </Button>
              </div>
            </section>

            {/* ── Maintenance (admin) ─────────────────────────────────── */}
            {me?.isAdmin && (
              <section className="overflow-hidden rounded-2xl border border-border bg-surface">
                <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
                  <Wrench className="h-4 w-4 text-text-muted" />
                  <h2 className="text-sm font-semibold text-text-primary">Maintenance</h2>
                </div>
                <div className="space-y-4 p-5">
                  <div className="space-y-2">
                    <p className="text-xs text-text-muted">
                      Remove orphaned thumbnails, leftover download temp files and stale cache
                      entries. Your videos are never touched.
                    </p>
                    <Button
                      variant="secondary"
                      className="w-full"
                      onClick={() => cleanMutation.mutate()}
                      disabled={cleanMutation.isPending}
                    >
                      {cleanMutation.isPending
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <Sparkles className="h-4 w-4" />}
                      Clean junk files
                    </Button>
                  </div>
                  <div className="space-y-2 border-t border-border pt-4">
                    <p className="text-xs text-text-muted">
                      Rebuild any missing or failed video thumbnails. Safe to run anytime — existing
                      thumbnails are kept. May take a while on large libraries.
                    </p>
                    <Button
                      variant="secondary"
                      className="w-full"
                      onClick={() => regenMutation.mutate()}
                      disabled={regenMutation.isPending}
                    >
                      {regenMutation.isPending
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <ImageIcon className="h-4 w-4" />}
                      Regenerate thumbnails
                    </Button>
                  </div>
                </div>
              </section>
            )}

            {/* ── Application (admin) ─────────────────────────────────── */}
            {me?.isAdmin && (
              <section className="overflow-hidden rounded-2xl border border-border bg-surface">
                <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
                  <Package className="h-4 w-4 text-text-muted" />
                  <h2 className="text-sm font-semibold text-text-primary">Application</h2>
                </div>
                <div className="space-y-3 p-5">
                  {appVersion?.current && (
                    <div className="flex items-center justify-between rounded-lg border border-border bg-elevated px-3 py-2.5">
                      <span className="text-xs text-text-muted">Current version</span>
                      <div className="flex items-center gap-2">
                        <div className={`h-1.5 w-1.5 rounded-full ${appVersion.updateAvailable ? 'bg-warning' : 'bg-success'}`} />
                        <span className={`text-xs font-mono ${appVersion.updateAvailable ? 'text-warning' : 'text-text-primary'}`}>
                          v{appVersion.current}
                          {appVersion.updateAvailable && ` → v${appVersion.latest}`}
                        </span>
                      </div>
                    </div>
                  )}
                  <p className="text-xs text-text-muted">
                    Pull the latest release from GitHub and rebuild. The server will restart automatically.
                  </p>
                  <Button variant="secondary" className="w-full" onClick={() => setShowUpdate(true)}>
                    Update application
                  </Button>

                  {/* yt-dlp component version + update */}
                  {ytdlp?.current && (
                    <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="text-xs text-text-muted">yt-dlp</span>
                        <span className="font-mono text-xs text-text-primary">{ytdlp.current}</span>
                        {ytdlp.outdated
                          ? <Badge variant="warning">→ {ytdlp.latest}</Badge>
                          : <Badge variant="success">up to date</Badge>}
                      </div>
                      <Button
                        size="sm"
                        variant={ytdlp.outdated ? 'default' : 'secondary'}
                        onClick={() => ytdlpUpdateMutation.mutate()}
                        disabled={ytdlpUpdateMutation.isPending}
                        className="h-7 shrink-0 px-2 text-xs"
                      >
                        {ytdlpUpdateMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Update'}
                      </Button>
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* ── Sign out ────────────────────────────────────────────── */}
            <section className="overflow-hidden rounded-2xl border border-danger/20 bg-surface">
              <div className="p-5">
                <Button
                  variant="outline"
                  className="w-full border-danger/30 text-danger hover:bg-danger/10 hover:border-danger/50"
                  onClick={() => logoutMutation.mutate()}
                  disabled={logoutMutation.isPending}
                >
                  {logoutMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
                  Sign out
                </Button>
              </div>
            </section>

          </div>
        </div>
      </div>

      <AppUpdateModal open={showUpdate} onClose={() => setShowUpdate(false)} />
    </>
  );
}
