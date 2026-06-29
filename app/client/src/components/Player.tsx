import { useEffect, useRef, useCallback } from 'react';
import { SkipBack, SkipForward, ChevronLeft } from 'lucide-react';
import Plyr from 'plyr';
import 'plyr/dist/plyr.css';
import { usePlayerStore } from '@/stores/playerStore';
import { cn } from '@/lib/utils';

const RESUME_KEY = (id: string) => `sv:pos:${id}`;

export function Player() {
  const { video, playlist, close, next, prev } = usePlayerStore();
  const videoRef = useRef<HTMLVideoElement>(null);
  const plyrRef = useRef<Plyr | null>(null);
  const touchStartX = useRef<number | null>(null);

  const idx = video && playlist.length ? playlist.findIndex(v => v.id === video.id) : -1;
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < playlist.length - 1;

  // Swipe-to-close on mobile (swipe down)
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientY;
  }, []);
  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const delta = e.changedTouches[0].clientY - touchStartX.current;
    if (delta > 80) close();
    touchStartX.current = null;
  }, [close]);

  useEffect(() => {
    if (!videoRef.current || !video) return;

    const player = new Plyr(videoRef.current, {
      controls: [
        'play-large', 'play', 'rewind', 'fast-forward', 'progress',
        'current-time', 'duration', 'mute', 'volume', 'captions',
        'settings', 'pip', 'fullscreen',
      ],
      keyboard: { focused: true, global: false },
      tooltips: { controls: true },
      invertTime: false,
      speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
      previewThumbnails: {
        enabled: true,
        src: `/api/videos/${video.id}/thumbs.vtt`,
      },
      // Better mobile experience
      clickToPlay: true,
      disableContextMenu: false,
      fullscreen: { enabled: true, fallback: true, iosNative: true },
    });
    plyrRef.current = player;

    // Restore resume position
    const saved = parseFloat(localStorage.getItem(RESUME_KEY(video.id)) || '0');
    if (saved > 5) {
      player.once('canplay', () => { player.currentTime = saved; });
    }

    const savePos = setInterval(() => {
      if (player.playing && player.currentTime > 5) {
        localStorage.setItem(RESUME_KEY(video.id), String(player.currentTime));
      }
    }, 3000);

    player.on('ended', () => {
      localStorage.removeItem(RESUME_KEY(video.id));
      if (hasNext) setTimeout(next, 800);
    });

    return () => {
      clearInterval(savePos);
      player.destroy();
      plyrRef.current = null;
    };
  }, [video?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    // Lock body scroll while player is open
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [close]);

  if (!video) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* Top bar — minimal, touch-friendly */}
      <div className="flex shrink-0 items-center gap-2 px-3 py-2 sm:px-4 sm:py-3 bg-gradient-to-b from-black/80 to-transparent absolute top-0 inset-x-0 z-10">
        <button
          onClick={close}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-sm hover:bg-black/60 active:scale-95 transition-all"
          aria-label="Close player"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white/90 leading-tight">{video.name}</p>
          {video.folder && (
            <p className="truncate text-xs text-white/50">{video.folder}</p>
          )}
        </div>

        {/* Playlist nav */}
        {playlist.length > 1 && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={prev}
              disabled={!hasPrev}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-full bg-black/40 backdrop-blur-sm transition-all active:scale-95',
                hasPrev ? 'text-white hover:bg-black/60' : 'text-white/30 cursor-not-allowed',
              )}
            >
              <SkipBack className="h-4 w-4" />
            </button>
            <span className="min-w-10 text-center text-xs text-white/60 font-mono tabular-nums">
              {idx + 1}/{playlist.length}
            </span>
            <button
              onClick={next}
              disabled={!hasNext}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-full bg-black/40 backdrop-blur-sm transition-all active:scale-95',
                hasNext ? 'text-white hover:bg-black/60' : 'text-white/30 cursor-not-allowed',
              )}
            >
              <SkipForward className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {/* Video — full viewport, centered */}
      <div className="flex flex-1 items-center justify-center overflow-hidden">
        <video
          ref={videoRef}
          key={video.id}
          src={`/stream/${video.id}`}
          className="h-full w-full"
          autoPlay
          playsInline
          webkit-playsinline="true"
        />
      </div>
    </div>
  );
}
