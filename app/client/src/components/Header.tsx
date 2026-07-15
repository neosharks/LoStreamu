import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Settings, LogOut, Plus, Download } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { Logo } from './Logo';
import { settingsApi, authApi } from '@/api/settings';
import { videosApi } from '@/api/videos';
import { cn } from '@/lib/utils';
import { AppUpdateModal } from './AppUpdateModal';

interface HeaderProps {
  onAddVideos: () => void;
  videoCount: number;
  search: string;
  onSearch: (q: string) => void;
}

export function Header({ onAddVideos, videoCount, search, onSearch }: HeaderProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [showUpdate, setShowUpdate] = useState(false);

  const { data: appVersion } = useQuery({
    queryKey: ['app-version'],
    queryFn: settingsApi.appVersion,
    staleTime: 60 * 60 * 1000,
    retry: false,
  });

  const rescanMutation = useMutation({
    mutationFn: videosApi.rescan,
    onSuccess: (data) => {
      toast.success(`Library rescanned — ${data.count} videos`);
      qc.invalidateQueries({ queryKey: ['videos'] });
      qc.invalidateQueries({ queryKey: ['tree'] });
    },
  });

  const logoutMutation = useMutation({
    mutationFn: authApi.logout,
    onSuccess: () => { window.location.href = '/login'; },
  });

  return (
    <header className="glass sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border px-4">
      {/* Brand */}
      <button
        onClick={() => navigate('/')}
        className="group flex items-center gap-2.5 shrink-0 outline-none"
        title="LoStreamu home"
      >
        <span className="drop-shadow-[0_2px_8px_rgba(99,102,241,0.45)] transition-transform duration-200 group-hover:scale-105 group-active:scale-95">
          <Logo size={28} />
        </span>
        <span className="text-sm font-semibold text-gradient">LoStreamu</span>
      </button>

      {/* Search */}
      <div className="relative flex-1">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
          className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-subtle pointer-events-none">
          <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
        </svg>
        <input
          value={search}
          onChange={e => onSearch(e.target.value)}
          placeholder="Search your library…"
          className="w-full rounded-lg border border-border bg-surface py-1.5 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      {/* Desktop-only: video count + version + app update */}
      <span className="hidden text-xs text-text-muted lg:block shrink-0">
        {videoCount} {videoCount === 1 ? 'video' : 'videos'}
      </span>
      {appVersion?.current && (
        <div className="hidden items-center gap-2 lg:flex shrink-0">
          <div className={cn('h-1.5 w-1.5 rounded-full', appVersion.updateAvailable ? 'bg-warning' : 'bg-success')} />
          <span className={cn('text-xs', appVersion.updateAvailable ? 'text-warning' : 'text-text-muted')}>
            v{appVersion.current}
            {appVersion.updateAvailable && ` → v${appVersion.latest}`}
          </span>
          {appVersion.updateAvailable && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowUpdate(true)}
              className="h-6 border-warning/40 text-warning hover:bg-warning/10 text-xs px-2"
            >
              Update app
            </Button>
          )}
        </div>
      )}

      <AppUpdateModal open={showUpdate} onClose={() => setShowUpdate(false)} />

      {/* Desktop action buttons */}
      <div className="hidden lg:flex items-center gap-1">
        <Button size="default" onClick={onAddVideos}>
          <Plus className="h-4 w-4" /> Add videos
        </Button>
        <Button size="icon" variant="ghost" onClick={() => navigate('/downloads')} title="Downloads">
          <Download className="h-4 w-4" />
        </Button>
        <Button
          size="icon" variant="ghost"
          onClick={() => rescanMutation.mutate()}
          disabled={rescanMutation.isPending}
          title="Rescan library"
        >
          <RefreshCw className={cn('h-4 w-4', rescanMutation.isPending && 'animate-spin')} />
        </Button>
        <Button size="icon" variant="ghost" onClick={() => navigate('/settings')} title="Settings">
          <Settings className="h-4 w-4" />
        </Button>
        <Button size="icon" variant="ghost" onClick={() => logoutMutation.mutate()} title="Sign out">
          <LogOut className="h-4 w-4" />
        </Button>
      </div>

      {/* Mobile: Add videos icon only */}
      <Button size="icon" variant="ghost" onClick={onAddVideos} className="lg:hidden" title="Add videos">
        <Plus className="h-4 w-4" />
      </Button>
    </header>
  );
}
