import { useState, useEffect, useMemo, type ComponentType } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ChevronLeft, User, Users, Wifi, Package, RefreshCw, LogOut,
  Loader2, Trash2, UserPlus, Sparkles, Image as ImageIcon, Wrench,
  KeyRound, Lock, MonitorSmartphone, ShieldCheck, Unlock,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { authApi, settingsApi, usersApi } from '@/api/settings';
import { ProfileAvatar } from '@/components/ProfileAvatar';
import { AvatarPicker } from '@/components/AvatarPicker';
import { PinField } from '@/components/PinField';
import { PIN_LENGTH } from '@/components/PinPad';
import type { AvatarKey } from '@/lib/avatars';
import { videosApi } from '@/api/videos';
import { AppUpdateModal } from '@/components/AppUpdateModal';
import { formatBytes, cn } from '@/lib/utils';

type TabId = 'account' | 'users' | 'network' | 'library' | 'application';

interface TabDef {
  id: TabId;
  label: string;
  icon: ComponentType<{ className?: string }>;
  admin?: boolean;
}

const TABS: TabDef[] = [
  { id: 'account', label: 'Account', icon: User },
  { id: 'users', label: 'Users', icon: Users, admin: true },
  { id: 'network', label: 'Network', icon: Wifi, admin: true },
  { id: 'library', label: 'Library & storage', icon: RefreshCw },
  { id: 'application', label: 'Application', icon: Package, admin: true },
];

// Card shell used by every settings panel — keeps spacing/borders consistent.
function Section({ icon: Icon, title, children }: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-surface">
      <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
        <Icon className="h-4 w-4 text-text-muted" />
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Settings() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

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

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [avatar, setAvatar] = useState<AvatarKey>('indigo');
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [proxy, setProxy] = useState('');
  const [showUpdate, setShowUpdate] = useState(false);

  // Add-profile form (admin only)
  const [draft, setDraft] = useState({ name: '', email: '', pin: '', isAdmin: false });
  const [draftAvatar, setDraftAvatar] = useState<AvatarKey>('violet');

  // PIN reset the admin hands to a member who forgot theirs
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPin, setResetPin] = useState('');

  useEffect(() => {
    if (!me) return;
    setName(me.name);
    setEmail(me.email);
    setAvatar(me.avatar as AvatarKey);
  }, [me]);
  useEffect(() => { if (settings) setProxy(settings.proxy ?? ''); }, [settings]);

  // ── Tab state lives in the URL (?tab=…) so a refresh or shared link reopens
  // the same panel, and non-admins never land on an admin-only tab. ──────────
  const visibleTabs = useMemo(() => TABS.filter(t => !t.admin || me?.isAdmin), [me?.isAdmin]);
  const requestedTab = searchParams.get('tab') as TabId | null;
  const activeTab: TabId =
    requestedTab && visibleTabs.some(t => t.id === requestedTab)
      ? requestedTab
      : 'account';
  const setActiveTab = (id: TabId) =>
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      id === 'account' ? next.delete('tab') : next.set('tab', id);
      return next;
    }, { replace: true });

  // If an admin-only tab is in the URL but the user isn't an admin, drop it.
  useEffect(() => {
    if (requestedTab && !visibleTabs.some(t => t.id === requestedTab)) {
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        next.delete('tab');
        return next;
      }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedTab, visibleTabs]);

  const profileMutation = useMutation({
    mutationFn: () => {
      const changingPin = !!newPin;
      const changingEmail = email.toLowerCase() !== me?.email;
      return authApi.updateProfile({
        name,
        avatar,
        ...(changingEmail ? { email } : {}),
        ...(changingPin ? { newPin } : {}),
        ...(changingPin || changingEmail ? { currentPin } : {}),
      });
    },
    onSuccess: () => {
      toast.success('Profile updated');
      setCurrentPin('');
      setNewPin('');
      setConfirmPin('');
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err: any) => toast.error(err.response?.data?.error || 'Update failed'),
  });

  const forgetDevicesMutation = useMutation({
    mutationFn: authApi.forgetDevices,
    onSuccess: () => {
      toast.success('Trusted devices cleared — the next sign-in needs email + PIN');
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (err: any) => toast.error(err.response?.data?.error || 'Could not clear devices'),
  });

  const proxyMutation = useMutation({
    mutationFn: () => settingsApi.setProxy(proxy),
    onSuccess: () => toast.success('Proxy saved — takes effect immediately'),
    onError: (err: any) => toast.error(err.response?.data?.error || 'Could not save proxy'),
  });

  const createUserMutation = useMutation({
    mutationFn: () => usersApi.create({
      name: draft.name.trim(),
      email: draft.email.trim(),
      pin: draft.pin,
      avatar: draftAvatar,
      isAdmin: draft.isAdmin,
    }),
    onSuccess: () => {
      toast.success(`Profile ${draft.name.trim()} created`);
      setDraft({ name: '', email: '', pin: '', isAdmin: false });
      qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err: any) => toast.error(err.response?.data?.error || 'Could not create profile'),
  });

  const resetPinMutation = useMutation({
    mutationFn: (id: string) => usersApi.update(id, { pin: resetPin }),
    onSuccess: () => {
      toast.success('PIN reset — that profile signs in with email + new PIN once');
      setResetFor(null);
      setResetPin('');
      qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err: any) => toast.error(err.response?.data?.error || 'Could not reset the PIN'),
  });

  const unlockMutation = useMutation({
    mutationFn: (id: string) => usersApi.unlock(id),
    onSuccess: () => {
      toast.success('Profile unlocked');
      qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err: any) => toast.error(err.response?.data?.error || 'Could not unlock'),
  });

  const deleteUserMutation = useMutation({
    mutationFn: (id: string) => usersApi.remove(id),
    onSuccess: () => {
      toast.success('Profile removed');
      qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err: any) => toast.error(err.response?.data?.error || 'Could not remove profile'),
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
      const parts: string[] = [];
      if (r.removedFiles) parts.push(`${r.removedFiles} file${r.removedFiles === 1 ? '' : 's'} · freed ${formatBytes(r.freedBytes)}`);
      if (r.emptyFolders) parts.push(`${r.emptyFolders} empty folder${r.emptyFolders === 1 ? '' : 's'}`);
      toast.success(parts.length ? `Cleaned ${parts.join(' · ')}` : 'Already clean — nothing to remove');
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

  // ── Panels ──────────────────────────────────────────────────────────────
  const pinChangeRequested = !!newPin || !!confirmPin;
  const pinMismatch = pinChangeRequested && newPin !== confirmPin;
  const emailChanged = !!me && email.toLowerCase() !== me.email;
  const needsPinToSave = pinChangeRequested || emailChanged;
  const profileSaveBlocked =
    !name.trim() ||
    pinMismatch ||
    (pinChangeRequested && newPin.length !== PIN_LENGTH) ||
    (needsPinToSave && currentPin.length !== PIN_LENGTH);

  const accountPanel = (
    <div className="space-y-4">
      <Section icon={User} title="Profile">
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <ProfileAvatar name={name || me?.name || 'You'} avatar={avatar} size={64} />
            <div className="min-w-0 flex-1 space-y-1.5">
              <label className="text-xs text-text-muted">Display name</label>
              <Input value={name} onChange={e => setName(e.target.value)} maxLength={40} />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-text-muted">Profile colour</label>
            <AvatarPicker value={avatar} onChange={setAvatar} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-text-muted">Email</label>
            <Input value={email} onChange={e => setEmail(e.target.value)} type="email" />
            <p className="text-[11px] text-text-subtle">
              Asked alongside your PIN the first time you sign in on a new device.
            </p>
          </div>
        </div>
      </Section>

      <Section icon={KeyRound} title="PIN">
        <div className="space-y-3">
          <p className="text-xs text-text-muted">
            Six digits, no repeated or consecutive runs. There is no reset link — an
            admin can issue a new PIN, but a forgotten admin PIN cannot be recovered.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs text-text-muted">New PIN</label>
              <PinField value={newPin} onChange={setNewPin} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-text-muted">Confirm new PIN</label>
              <PinField value={confirmPin} onChange={setConfirmPin} />
            </div>
          </div>
          {pinMismatch && <p className="text-xs text-danger">The two PINs do not match.</p>}
          {needsPinToSave && (
            <div className="space-y-1.5">
              <label className="text-xs text-text-muted">
                Current PIN <span className="text-danger">*</span>
              </label>
              <PinField value={currentPin} onChange={setCurrentPin} />
              <p className="text-[11px] text-text-subtle">
                Required to change your {pinChangeRequested ? 'PIN' : 'email'}.
              </p>
            </div>
          )}
          <Button
            onClick={() => profileMutation.mutate()}
            disabled={profileSaveBlocked || profileMutation.isPending}
            className="w-full"
          >
            {profileMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Save changes
          </Button>
        </div>
      </Section>

      <Section icon={MonitorSmartphone} title="Trusted devices">
        <div className="space-y-3">
          <p className="text-xs text-text-muted">
            {me?.devices
              ? `${me.devices} browser${me.devices === 1 ? '' : 's'} can sign in with your PIN alone.`
              : 'No browser is trusted yet — the next sign-in will ask for your email too.'}
            {' '}Clear them if a device is lost or shared.
          </p>
          <Button
            variant="secondary"
            className="w-full"
            onClick={() => forgetDevicesMutation.mutate()}
            disabled={!me?.devices || forgetDevicesMutation.isPending}
          >
            {forgetDevicesMutation.isPending
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Lock className="h-4 w-4" />}
            Forget all devices
          </Button>
        </div>
      </Section>

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
  );

  const usersPanel = (
    <Section icon={Users} title="Profiles">
      <div className="space-y-2.5">
        {managedUsers.map(u => (
          <div key={u.id} className="rounded-xl border border-border bg-elevated/60 p-3">
            <div className="flex items-center gap-3">
              <ProfileAvatar name={u.name} avatar={u.avatar} size={40} className="rounded-xl" />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate text-sm font-medium text-text-primary">
                  {u.name}
                  {u.isAdmin && <Badge variant="default">admin</Badge>}
                  {u.id === me?.id && <span className="text-[11px] text-text-subtle">you</span>}
                </p>
                <p className="truncate text-[11px] text-text-muted">{u.email}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {u.lockedFor > 0 && (
                  <button
                    onClick={() => unlockMutation.mutate(u.id)}
                    disabled={unlockMutation.isPending}
                    title={`Locked for ${u.lockedFor}s — unlock now`}
                    className="rounded p-1.5 text-warning transition-colors hover:bg-warning/10"
                  >
                    <Unlock className="h-4 w-4" />
                  </button>
                )}
                <button
                  onClick={() => { setResetFor(resetFor === u.id ? null : u.id); setResetPin(''); }}
                  title="Set a new PIN"
                  className="rounded p-1.5 text-text-muted transition-colors hover:bg-accent/10 hover:text-accent"
                >
                  <KeyRound className="h-4 w-4" />
                </button>
                {u.id !== me?.id && (
                  <button
                    onClick={() => deleteUserMutation.mutate(u.id)}
                    disabled={deleteUserMutation.isPending}
                    title="Remove profile"
                    className="rounded p-1.5 text-text-muted transition-colors hover:bg-danger/10 hover:text-danger"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>

            {resetFor === u.id && (
              <div className="mt-3 flex items-end gap-2 border-t border-border pt-3">
                <div className="flex-1 space-y-1.5">
                  <label className="text-xs text-text-muted">New 6-digit PIN</label>
                  <PinField value={resetPin} onChange={setResetPin} />
                </div>
                <Button
                  onClick={() => resetPinMutation.mutate(u.id)}
                  disabled={resetPin.length !== PIN_LENGTH || resetPinMutation.isPending}
                >
                  {resetPinMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  Set PIN
                </Button>
              </div>
            )}
          </div>
        ))}

        <div className="mt-3 space-y-2.5 rounded-xl border border-border bg-elevated/50 p-3">
          <p className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
            <UserPlus className="h-3.5 w-3.5" /> Add profile
          </p>
          <div className="flex items-center gap-3">
            <ProfileAvatar name={draft.name || 'New'} avatar={draftAvatar} size={40} className="rounded-xl" />
            <Input
              value={draft.name}
              onChange={e => setDraft({ ...draft, name: e.target.value })}
              placeholder="Display name"
              maxLength={40}
            />
          </div>
          <AvatarPicker value={draftAvatar} onChange={setDraftAvatar} />
          <Input
            type="email"
            value={draft.email}
            onChange={e => setDraft({ ...draft, email: e.target.value })}
            placeholder="Email address"
            autoComplete="off"
          />
          <PinField
            value={draft.pin}
            onChange={pin => setDraft({ ...draft, pin })}
            placeholder="6-digit PIN"
          />
          <label className="flex cursor-pointer items-center gap-2 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={draft.isAdmin}
              onChange={e => setDraft({ ...draft, isAdmin: e.target.checked })}
              className="h-3.5 w-3.5 accent-accent"
            />
            <ShieldCheck className="h-3.5 w-3.5" /> Make this profile an admin
          </label>
          <Button
            className="w-full"
            onClick={() => createUserMutation.mutate()}
            disabled={
              !draft.name.trim() ||
              !draft.email.trim() ||
              draft.pin.length !== PIN_LENGTH ||
              createUserMutation.isPending
            }
          >
            {createUserMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Create profile
          </Button>
          <p className="text-[11px] text-text-subtle">
            Share the PIN with them — their first sign-in on each device also asks for
            this email. They can change both from their own settings.
          </p>
        </div>
      </div>
    </Section>
  );

  const networkPanel = (
    <Section icon={Wifi} title="Network · Proxy / VPN">
      <div className="space-y-3">
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
    </Section>
  );

  const libraryPanel = (
    <div className="space-y-4">
      <Section icon={RefreshCw} title="Library">
        <div className="space-y-3">
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
      </Section>

      {me?.isAdmin && (
        <Section icon={Wrench} title="Maintenance">
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="text-xs text-text-muted">
                Remove orphaned thumbnails, leftover download temp files, stale cache
                entries and empty folders. Your videos are never touched.
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
        </Section>
      )}
    </div>
  );

  const applicationPanel = (
    <Section icon={Package} title="Application">
      <div className="space-y-3">
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
    </Section>
  );

  const panels: Record<TabId, React.ReactNode> = {
    account: accountPanel,
    users: usersPanel,
    network: networkPanel,
    library: libraryPanel,
    application: applicationPanel,
  };

  return (
    <>
      <div className="flex h-screen flex-col overflow-hidden bg-bg">
        <header
          className="glass sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border px-4"
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
            className="mx-auto max-w-4xl px-4 py-6 lg:flex lg:gap-6"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1.5rem)' }}
          >
            {/* Section nav — sticky rail on desktop, horizontal scroller on mobile */}
            <nav
              className={cn(
                'mb-4 flex gap-1.5 overflow-x-auto pb-1 lg:mb-0 lg:w-52 lg:shrink-0 lg:flex-col lg:overflow-visible lg:pb-0',
                'lg:sticky lg:top-6 lg:self-start',
              )}
            >
              {visibleTabs.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  className={cn(
                    'flex shrink-0 items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-sm font-medium transition-colors lg:w-full',
                    activeTab === id
                      ? 'bg-accent-light text-accent-hover'
                      : 'text-text-muted hover:bg-elevated hover:text-text-primary',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="whitespace-nowrap">{label}</span>
                </button>
              ))}
            </nav>

            {/* Active panel */}
            <div className="min-w-0 flex-1">
              {panels[activeTab]}
            </div>
          </div>
        </div>
      </div>

      <AppUpdateModal open={showUpdate} onClose={() => setShowUpdate(false)} />
    </>
  );
}
