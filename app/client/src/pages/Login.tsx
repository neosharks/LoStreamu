import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authApi } from '@/api/settings';

type Mode = 'loading' | 'login' | 'setup';

export function Login() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('loading');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      authApi.me().then(() => navigate('/')).catch(() => null),
      authApi.setupState().then(d => { if (!d.hasAccount) setMode('setup'); else setMode('login'); }),
    ]);
  }, [navigate]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (mode === 'setup' && password !== confirm) { setError('Passwords do not match.'); return; }
    setPending(true);
    try {
      if (mode === 'setup') await authApi.signup(email, password);
      else await authApi.login(email, password);
      navigate('/');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Something went wrong.');
    } finally {
      setPending(false);
    }
  };

  if (mode === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center bg-bg">
        <Loader2 className="h-6 w-6 animate-spin text-accent" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg px-4">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-accent/5 blur-3xl" />
      </div>

      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent shadow-xl shadow-accent/30">
            <Play className="h-7 w-7 text-white" fill="white" />
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-bold text-text-primary">StreamVault</h1>
            <p className="mt-1 text-sm text-text-muted">
              {mode === 'setup' ? 'Create your admin account to get started' : 'Sign in to your library'}
            </p>
          </div>
        </div>

        <form onSubmit={submit} className="rounded-2xl border border-border bg-surface p-6 shadow-xl shadow-black/20 space-y-4">
          {mode === 'setup' && (
            <div className="rounded-lg bg-accent/10 px-3 py-2 text-xs text-accent">
              First-time setup — this account will be the admin.
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-text-muted">Email address</label>
            <Input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              autoComplete="email"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-text-muted">Password</label>
            <Input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={mode === 'setup' ? 'Min 8 characters' : '••••••••'}
              required
              autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
            />
          </div>
          {mode === 'setup' && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-text-muted">Confirm password</label>
              <Input
                type="password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder="••••••••"
                required
                autoComplete="new-password"
              />
            </div>
          )}
          {error && (
            <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>
          )}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            {mode === 'setup' ? 'Create admin account' : 'Sign in'}
          </Button>
        </form>

        <p className="mt-4 text-center text-xs text-text-subtle">
          StreamVault — self-hosted video streaming
        </p>
      </div>
    </div>
  );
}
