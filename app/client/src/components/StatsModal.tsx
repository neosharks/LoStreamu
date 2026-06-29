import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from './ui/dialog';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { videosApi } from '@/api/videos';
import { settingsApi } from '@/api/settings';
import { formatBytes, formatUptime } from '@/lib/utils';

interface StatsModalProps {
  open: boolean;
  onClose: () => void;
}

function GaugeRow({ label, used, total }: { label: string; used: number; total: number }) {
  const pct = total ? (used / total) * 100 : 0;
  const color = pct > 90 ? 'bg-danger' : pct > 75 ? 'bg-warning' : 'bg-accent';
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="text-text-muted">{label}</span>
        <span className="font-mono text-xs text-text-primary tabular-nums">
          {formatBytes(used)} / {formatBytes(total)} · {pct.toFixed(0)}%
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct.toFixed(1)}%` }} />
      </div>
    </div>
  );
}

export function StatsModal({ open, onClose }: StatsModalProps) {
  const qc = useQueryClient();

  const { data: stats, isLoading: statsLoading, refetch } = useQuery({
    queryKey: ['stats'],
    queryFn: videosApi.stats,
    enabled: open,
    refetchInterval: open ? 15_000 : false,
  });

  const { data: ytdlp } = useQuery({
    queryKey: ['ytdlp-version'],
    queryFn: settingsApi.ytdlpVersion,
    enabled: open,
    retry: false,
  });

  const updateMutation = useMutation({
    mutationFn: settingsApi.ytdlpUpdate,
    onSuccess: (data) => {
      toast.success(`yt-dlp updated to ${data.version}`);
      qc.invalidateQueries({ queryKey: ['ytdlp-version'] });
    },
    onError: (err: any) => toast.error(err.response?.data?.error || 'Update failed'),
  });

  const rows = stats ? [
    { label: 'Videos', value: stats.videos.toLocaleString() },
    { label: 'Library size', value: formatBytes(stats.libraryBytes) },
    { label: 'CPU cores', value: stats.cpu.count.toString() },
    { label: 'Load avg', value: stats.cpu.load.map(x => x.toFixed(2)).join(' · ') },
    { label: 'Server uptime', value: formatUptime(stats.uptime.system) },
    { label: 'App uptime', value: formatUptime(stats.uptime.process) },
    { label: 'Node.js', value: stats.node },
    { label: 'Platform', value: stats.platform },
    { label: 'Active downloads', value: stats.activeDownloads.toString() },
  ] : [];

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center justify-between pr-6">
            <DialogTitle>Server stats</DialogTitle>
            <Button size="icon-sm" variant="ghost" onClick={() => refetch()}>
              <RefreshCw className={`h-3.5 w-3.5 ${statsLoading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {statsLoading && !stats ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
            </div>
          ) : (
            <>
              {/* Gauges */}
              {stats?.disk && <GaugeRow label="Disk" used={stats.disk.used} total={stats.disk.total} />}
              {stats?.mem && <GaugeRow label="Memory" used={stats.mem.used} total={stats.mem.total} />}

              {/* Rows */}
              <div className="divide-y divide-border rounded-xl border border-border overflow-hidden">
                {rows.map(row => (
                  <div key={row.label} className="flex items-center justify-between px-4 py-2.5">
                    <span className="text-sm text-text-muted">{row.label}</span>
                    <span className="font-mono text-xs text-text-primary">{row.value}</span>
                  </div>
                ))}
                {/* yt-dlp row */}
                {ytdlp?.current && (
                  <div className="flex items-center justify-between px-4 py-2.5 gap-3">
                    <span className="text-sm text-text-muted">yt-dlp</span>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono text-xs text-text-primary shrink-0">{ytdlp.current}</span>
                      {ytdlp.outdated
                        ? <Badge variant="warning">→ {ytdlp.latest}</Badge>
                        : <Badge variant="success">up to date</Badge>}
                      <Button
                        size="sm"
                        variant={ytdlp.outdated ? 'default' : 'secondary'}
                        onClick={() => updateMutation.mutate()}
                        disabled={updateMutation.isPending}
                        className="h-6 text-xs px-2 shrink-0"
                      >
                        {updateMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Update'}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
