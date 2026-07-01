import { useState, useEffect, useRef, useCallback } from 'react';
import { Play, MoreVertical, Pencil, Trash2, Move, Download, Check, Film, X } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { formatBytes, formatDuration, cn } from '@/lib/utils';
import type { Video } from '@/types';

// Must match backend COLS / ROWS in services/media.ts generateSprite
const SPRITE_COLS = 5;
const SPRITE_ROWS = 5;
const SPRITE_TOTAL = SPRITE_COLS * SPRITE_ROWS;

// 25 frames over ~4 s
const FRAME_MS = 160;

interface VideoCardProps {
  video: Video;
  onPlay: (video: Video) => void;
  onRename: (video: Video) => void;
  onDelete: (video: Video) => void;
  onMove: (video: Video) => void;
  selected?: boolean;
  onToggleSelect?: (video: Video) => void;
}

export function VideoCard({ video, onPlay, onRename, onDelete, onMove, selected, onToggleSelect }: VideoCardProps) {
  const [thumbErr, setThumbErr]       = useState(false);
  const [hoverX, setHoverX]           = useState<number | null>(null);
  const [spriteLoaded, setSpriteLoaded] = useState(false);
  const [playing, setPlaying]         = useState(false);
  const [frameIdx, setFrameIdx]       = useState(0);

  const cardRef      = useRef<HTMLDivElement>(null);
  const intervalRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const isPlayRef    = useRef(false);
  const spriteOkRef  = useRef(false);

  const spriteUrl = `/api/videos/${video.id}/sprite.jpg`;

  // Frame index to display — animated frames win over hover-scrub
  const activeIdx = playing
    ? frameIdx
    : hoverX !== null
      ? Math.min(SPRITE_TOTAL - 1, Math.floor(hoverX * SPRITE_TOTAL))
      : 0;

  const col  = activeIdx % SPRITE_COLS;
  const row  = Math.floor(activeIdx / SPRITE_COLS);
  const bgX  = (col / (SPRITE_COLS - 1)) * 100;
  const bgY  = (row / (SPRITE_ROWS - 1)) * 100;
  const frameSecs   = video.duration ? activeIdx * (video.duration / SPRITE_TOTAL) : null;
  const showSprite  = (hoverX !== null || playing) && spriteLoaded;
  const barProgress = playing ? (frameIdx / (SPRITE_TOTAL - 1)) * 100 : (hoverX ?? 0) * 100;

  const loadSprite = useCallback(() => {
    if (spriteOkRef.current) return;
    const img = new Image();
    img.onload = () => { spriteOkRef.current = true; setSpriteLoaded(true); };
    img.src = spriteUrl;
  }, [spriteUrl]);

  const startAnimation = useCallback(() => {
    if (isPlayRef.current) return;
    loadSprite();
    isPlayRef.current = true;
    setPlaying(true);
    setFrameIdx(0);
    let f = 0;
    intervalRef.current = setInterval(() => {
      f++;
      if (f >= SPRITE_TOTAL) {
        clearInterval(intervalRef.current!);
        intervalRef.current = null;
        isPlayRef.current = false;
        setPlaying(false);
        setFrameIdx(0);
        return;
      }
      setFrameIdx(f);
    }, FRAME_MS);
  }, [loadSprite]);

  const stopAnimation = useCallback(() => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    isPlayRef.current = false;
    setPlaying(false);
    setFrameIdx(0);
  }, []);

  // Cleanup on unmount
  useEffect(() => () => { if (intervalRef.current) clearInterval(intervalRef.current); }, []);

  const trackHover = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setHoverX(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
  };

  const onMouseEnter = (e: React.MouseEvent<HTMLDivElement>) => {
    trackHover(e);
    loadSprite();
  };

  return (
    <div
      ref={cardRef}
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-xl border bg-surface transition-all duration-200 hover:shadow-lg hover:shadow-black/20',
        selected ? 'border-accent ring-2 ring-accent/30' : 'border-border hover:border-accent/40',
      )}
    >
      {/* Thumbnail */}
      <div
        className="relative aspect-video cursor-pointer overflow-hidden bg-elevated"
        onClick={() => onPlay(video)}
        onMouseEnter={onMouseEnter}
        onMouseMove={trackHover}
        onMouseLeave={() => setHoverX(null)}
      >
        {/* Static thumbnail */}
        {!thumbErr ? (
          <img
            src={`/thumb/${video.id}`}
            alt={video.name}
            className={cn('h-full w-full object-cover transition-opacity duration-150', showSprite && 'opacity-0')}
            onError={() => setThumbErr(true)}
            loading="lazy"
          />
        ) : (
          <div className={cn('flex h-full items-center justify-center', showSprite && 'opacity-0')}>
            <Play className="h-10 w-10 text-text-subtle" />
          </div>
        )}

        {/* Sprite frame */}
        {showSprite && (
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: `url(${spriteUrl})`,
              backgroundSize: `${SPRITE_COLS * 100}% ${SPRITE_ROWS * 100}%`,
              backgroundPosition: `${bgX}% ${bgY}%`,
              backgroundRepeat: 'no-repeat',
            }}
          />
        )}

        {/* Progress bar */}
        {showSprite && (
          <div className="absolute inset-x-0 bottom-0 h-0.5 bg-white/20">
            <div className="h-full bg-accent" style={{ width: `${barProgress}%` }} />
          </div>
        )}

        {/* Frame timestamp */}
        {showSprite && frameSecs !== null && (
          <span className="absolute bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums bg-black/80 text-white">
            {formatDuration(frameSecs)}
          </span>
        )}

        {/* Play overlay (hidden while scrubbing / animating) */}
        {!showSprite && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/30">
            <div className="flex h-11 w-11 scale-90 items-center justify-center rounded-full bg-accent/90 opacity-0 shadow-lg transition-all duration-200 group-hover:scale-100 group-hover:opacity-100">
              <Play className="h-5 w-5 text-white" fill="white" />
            </div>
          </div>
        )}

        {/* Selection checkbox (top-left) */}
        {onToggleSelect && (
          <button
            onClick={e => { e.stopPropagation(); onToggleSelect(video); }}
            className={cn(
              'absolute left-2 top-2 flex h-5 w-5 items-center justify-center rounded-md border-2 transition-all',
              selected
                ? 'border-accent bg-accent text-white opacity-100'
                : 'border-white/70 bg-black/30 text-transparent opacity-0 group-hover:opacity-100',
            )}
          >
            {selected && <Check className="h-3 w-3" strokeWidth={3} />}
          </button>
        )}

        {/* Duration badge (hidden while sprite showing) */}
        {video.duration && !showSprite && (
          <span className="absolute bottom-2 right-2 rounded px-1.5 py-0.5 text-xs font-medium bg-black/70 text-white">
            {formatDuration(video.duration)}
          </span>
        )}

        {/* Play Frames button (top-right)
            Desktop: fades in on card hover
            Mobile (hover:none devices): always visible at reduced opacity  */}
        <button
          onClick={e => { e.stopPropagation(); playing ? stopAnimation() : startAnimation(); }}
          title={playing ? 'Stop preview' : 'Preview frames'}
          className={cn(
            'absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full backdrop-blur-sm transition-all duration-150',
            playing
              ? 'bg-accent text-white opacity-100 scale-100'
              : 'bg-black/55 text-white opacity-40 scale-95 group-hover:opacity-100 group-hover:scale-100',
          )}
        >
          {playing
            ? <X className="h-3.5 w-3.5" />
            : <Film className="h-3.5 w-3.5" />}
        </button>
      </div>

      {/* Info row */}
      <div className="flex items-start gap-2 p-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text-primary leading-snug">{video.name}</p>
          <p className="mt-0.5 text-xs text-text-muted">{formatBytes(video.size)}</p>
        </div>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="mt-0.5 rounded-md p-1 text-text-subtle opacity-0 transition-opacity hover:bg-elevated hover:text-text-primary group-hover:opacity-100 focus:opacity-100 focus:outline-none">
              <MoreVertical className="h-4 w-4" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="z-50 min-w-36 overflow-hidden rounded-xl border border-border bg-elevated p-1 shadow-xl shadow-black/40 animate-fade-in"
              align="end"
            >
              {[
                { icon: Pencil,   label: 'Rename',   onClick: () => onRename(video) },
                { icon: Move,     label: 'Move',     onClick: () => onMove(video) },
                { icon: Download, label: 'Download', onClick: () => { window.location.href = `/api/videos/${video.id}/download`; } },
                { icon: Trash2,   label: 'Delete',   onClick: () => onDelete(video), danger: true },
              ].map(({ icon: Icon, label, onClick, danger }) => (
                <DropdownMenu.Item
                  key={label}
                  onClick={onClick}
                  className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm outline-none transition-colors
                    ${danger ? 'text-danger hover:bg-danger/10' : 'text-text-primary hover:bg-border'}`}
                >
                  <Icon className="h-3.5 w-3.5" /> {label}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </div>
  );
}
