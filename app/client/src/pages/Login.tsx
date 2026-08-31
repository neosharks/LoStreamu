import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Loader2, Lock, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Logo } from '@/components/Logo';
import { PinPad, PIN_LENGTH } from '@/components/PinPad';
import { PinField } from '@/components/PinField';
import { ProfileAvatar } from '@/components/ProfileAvatar';
import { AvatarPicker } from '@/components/AvatarPicker';
import { authApi } from '@/api/settings';
import type { Profile } from '@/types';
import type { AvatarKey } from '@/lib/avatars';
import { cn } from '@/lib/utils';

// Sign-in is Netflix-shaped: the app opens on the household's profiles, you tap
// yours and type a 6-digit PIN. A browser the server has never seen also has to
// prove the profile's email once; after that the PIN alone gets you in.
type Stage = 'loading' | 'setup' | 'picker' | 'pin';

export function Login() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [stage, setStage] = useState<Stage>('loading');
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selected, setSelected] = useState<Profile | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  // PIN stage
  const [pin, setPin] = useState('');
  const [email, setEmail] = useState('');
  const [remember, setRemember] = useState(true);
  const [shake, setShake] = useState(false);
  const [lockedFor, setLockedFor] = useState(0);

  // First-run stage
  const [name, setName] = useState('');
  const [setupPin, setSetupPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [avatar, setAvatar] = useState<AvatarKey>('indigo');

  const enterApp = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ['me'] });
    navigate('/');
  }, [qc, navigate]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try { await authApi.me(); if (!cancelled) navigate('/'); return; } catch {}
      try {
        const { hasAccount } = await authApi.setupState();
        if (cancelled) return;
        if (!hasAccount) { setStage('setup'); return; }
        setProfiles(await authApi.profiles());
        if (!cancelled) setStage('picker');
      } catch {
        if (!cancelled) setError('Cannot reach the server.');
      }
    })();
    return () => { cancelled = true; };
  }, [navigate]);

  // Tick a lockout down so the PIN pad re-enables itself without a refresh.
  useEffect(() => {
    if (lockedFor <= 0) return;
    const t = setInterval(() => setLockedFor(s => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [lockedFor]);

  const reject = (message: string, retryAfter?: number) => {
    setError(message);
    setPin('');
    setShake(true);
    setTimeout(() => setShake(false), 450);
    if (retryAfter) setLockedFor(retryAfter);
  };

  const pickProfile = (profile: Profile) => {
    setSelected(profile);
    setPin('');
    setEmail('');
    setError('');
    setLockedFor(profile.lockedFor);
    setStage('pin');
  };

  const backToPicker = async () => {
    setStage('picker');
    setSelected(null);
    setPin('');
    setError('');
    try { setProfiles(await authApi.profiles()); } catch {}
  };

  const submitPin = async (value: string) => {
    if (!selected || pending || lockedFor > 0) return;
    if (selected.needsEmail && !email.trim()) { reject('Enter the email for this profile.'); return; }
    setPending(true);
    setError('');
    try {
      await authApi.login({
        userId: selected.id,
        pin: value,
        ...(selected.needsEmail ? { email: email.trim(), remember } : {}),
      });
      await enterApp();
    } catch (err: any) {
      const data = err.response?.data;
      reject(data?.error || 'Could not sign in.', data?.retryAfter);
    } finally {
      setPending(false);
    }
  };

  const submitSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (setupPin !== confirmPin) { setError('The two PINs do not match.'); return; }
    setPending(true);
    try {
      await authApi.setup({ name: name.trim(), email: email.trim(), pin: setupPin, avatar });
      await enterApp();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Could not create the profile.');
    } finally {
      setPending(false);
    }
  };

  if (stage === 'loading') {
    return (
      <Shell>
        <Loader2 className="h-6 w-6 animate-spin text-accent" />
      </Shell>
    );
  }

  if (stage === 'setup') {
    return (
      <Shell>
        <div className="w-full max-w-sm animate-fade-up">
          <Brand subtitle="Create the admin profile to get started" />
          <form onSubmit={submitSetup} className="space-y-4 rounded-2xl border border-border bg-surface p-6 shadow-xl shadow-black/20">
            <div className="flex items-start gap-2 rounded-lg bg-accent/10 px-3 py-2 text-xs text-accent">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                This first profile is the admin and can add everyone else. Your 6-digit
                PIN is the only way in — it cannot be recovered, so pick one you will remember.
              </span>
            </div>

            <div className="flex items-center gap-4">
              <ProfileAvatar name={name || 'You'} avatar={avatar} size={56} />
              <div className="min-w-0 flex-1 space-y-1.5">
                <label className="text-xs font-medium text-text-muted">Display name</label>
                <Input value={name} onChange={e => setName(e.target.value)} placeholder="Your name" required maxLength={40} />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-text-muted">Profile colour</label>
              <AvatarPicker value={avatar} onChange={setAvatar} />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-text-muted">Email address</label>
              <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" required autoComplete="email" />
              <p className="text-[11px] text-text-subtle">Asked for the first time you sign in on a new device.</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-text-muted">6-digit PIN</label>
                <PinField value={setupPin} onChange={setSetupPin} />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-text-muted">Confirm PIN</label>
                <PinField value={confirmPin} onChange={setConfirmPin} />
              </div>
            </div>

            {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

            <Button
              type="submit"
              className="w-full"
              disabled={pending || !name.trim() || !email.trim() || setupPin.length !== PIN_LENGTH}
            >
              {pending && <Loader2 className="h-4 w-4 animate-spin" />}
              Create admin profile
            </Button>
          </form>
        </div>
      </Shell>
    );
  }

  if (stage === 'pin' && selected) {
    const locked = lockedFor > 0;
    return (
      <Shell>
        <div className="w-full max-w-sm animate-fade-up">
          <button
            onClick={backToPicker}
            className="mb-4 inline-flex items-center gap-1 text-xs text-text-muted transition-colors hover:text-text-primary"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> All profiles
          </button>

          <div className="rounded-2xl border border-border bg-surface p-6 shadow-xl shadow-black/20">
            <div className="mb-6 flex flex-col items-center gap-3">
              <span className="animate-pop-in drop-shadow-[0_8px_24px_rgba(99,102,241,0.45)]">
                <ProfileAvatar name={selected.name} avatar={selected.avatar} size={72} />
              </span>
              <div className="text-center">
                <p className="text-lg font-semibold text-text-primary">{selected.name}</p>
                <p className="text-xs text-text-muted">
                  {locked
                    ? `Locked — try again in ${lockedFor}s`
                    : selected.needsEmail ? 'New device — confirm your email and PIN' : 'Enter your PIN'}
                </p>
              </div>
            </div>

            {selected.needsEmail && (
              <div className="mb-5 space-y-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-text-muted">Email address</label>
                  <Input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoComplete="email"
                    disabled={locked}
                  />
                </div>
                <label className="flex cursor-pointer items-center gap-2 text-xs text-text-muted">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={e => setRemember(e.target.checked)}
                    className="h-3.5 w-3.5 accent-accent"
                  />
                  Trust this device — PIN only next time
                </label>
              </div>
            )}

            <PinPad
              value={pin}
              onChange={setPin}
              onComplete={submitPin}
              disabled={pending || locked}
              shake={shake}
            />

            {pending && (
              <p className="mt-5 flex items-center justify-center gap-2 text-xs text-text-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…
              </p>
            )}
            {error && !pending && (
              <p className="mt-5 rounded-lg bg-danger/10 px-3 py-2 text-center text-sm text-danger">{error}</p>
            )}
            {locked && (
              <p className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-text-subtle">
                <Lock className="h-3 w-3" /> Too many wrong PINs. The wait grows with each miss.
              </p>
            )}
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="w-full max-w-2xl animate-fade-up text-center">
        <Brand subtitle="Who's watching?" />
        <div className="flex flex-wrap items-start justify-center gap-5 sm:gap-7">
          {profiles.map((p, i) => (
            <ProfileTile key={p.id} profile={p} index={i} onSelect={() => pickProfile(p)} />
          ))}
        </div>
        {!profiles.length && (
          <p className="text-sm text-text-muted">No profiles yet — ask the admin to create one.</p>
        )}
        {error && <p className="mt-6 text-sm text-danger">{error}</p>}
        <p className="mt-10 text-xs text-text-subtle">LoStreamu — self-hosted video streaming</p>
      </div>
    </Shell>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

/** Ambient background shared by every stage, so switching stages doesn't flash. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg px-4 py-10">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 h-96 w-96 -translate-x-1/2 animate-float rounded-full bg-accent/10 blur-3xl" />
        <div className="absolute -bottom-40 right-0 h-80 w-80 animate-float rounded-full bg-accent-hover/5 blur-3xl [animation-delay:1.5s]" />
      </div>
      <div className="relative flex w-full flex-col items-center">{children}</div>
    </div>
  );
}

function Brand({ subtitle }: { subtitle: string }) {
  return (
    <div className="mb-8 flex flex-col items-center gap-3">
      <span className="drop-shadow-[0_6px_20px_rgba(99,102,241,0.5)]">
        <Logo size={60} animated />
      </span>
      <div className="text-center">
        <h1 className="text-3xl font-bold text-gradient">LoStreamu</h1>
        <p className="mt-1 text-sm text-text-muted">{subtitle}</p>
      </div>
    </div>
  );
}

/** One profile in the picker — tiles land in sequence, then lift on hover. */
function ProfileTile({ profile, index, onSelect }: {
  profile: Profile;
  index: number;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      style={{ animationDelay: `${index * 70}ms` }}
      className={cn(
        'group flex animate-pop-in flex-col items-center gap-2.5 rounded-2xl p-2 outline-none',
        'transition-transform duration-200 hover:-translate-y-1 active:scale-95',
        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
      )}
    >
      <span className="rounded-2xl ring-2 ring-transparent transition-all duration-200 group-hover:ring-accent group-hover:drop-shadow-[0_10px_28px_rgba(99,102,241,0.45)] group-focus-visible:ring-accent">
        <ProfileAvatar name={profile.name} avatar={profile.avatar} size={104} />
      </span>
      <span className="max-w-[7rem] truncate text-sm text-text-muted transition-colors group-hover:text-text-primary">
        {profile.name}
      </span>
      {profile.lockedFor > 0 && (
        <span className="flex items-center gap-1 text-[11px] text-warning">
          <Lock className="h-3 w-3" /> {profile.lockedFor}s
        </span>
      )}
    </button>
  );
}
