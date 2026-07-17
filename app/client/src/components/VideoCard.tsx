import { useState, useRef } from 'react';
import { Play, MoreVertical, Pencil, Trash2, Move, Download, Check } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { formatBytes, formatDuration, cn } from '@/lib/utils';
import type { Video } from '@/types';

// Touch devices have no hover, so the selection checkbox must be visible up-front
// and long-press must be able to enter select mode.
const IS_TOUCH =
  typeof window !== 'undefined' &&
  window.matchMedia('(hover: none) and (pointer: coarse)').matches;

const LONG_PRESS_MS = 450;

interface VideoCardProps {
  video: Video;
  onPlay: (video: Video) => void;
  onRename: (video: Video) => void;
  onDelete: (video: Video) => void;
  onMove: (video: Video) => void;
  selected?: boolean;
  onToggleSelect?: (video: Video) => void;
  /** True when the library is in bulk-select mode — a tap toggles instead of plays. */
  selectionMode?: boolean;
  /** Grid position — drives the staggered entrance animation. */
  index?: number;
}

export function VideoCard({ video, onPlay, onRename, onDelete, onMove, selected, onToggleSelect, selectionMode, index = 0 }: VideoCardProps) {
  const [thumbErr, setThumbErr] = useState(false);
  // Set true when a long-press fires so the click it precedes doesn't also play.
  const longPressed = useRef(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout>>();

  const startPress = () => {
    if (!onToggleSelect) return;
    longPressed.current = false;
    pressTimer.current = setTimeout(() => {
      longPressed.current = true;
      onToggleSelect(video); // enter select mode + select this card
    }, LONG_PRESS_MS);
  };
  const cancelPress = () => clearTimeout(pressTimer.current);

  const onThumbClick = () => {
    if (longPressed.current) { longPressed.current = false; return; } // consumed by long-press
    if (selectionMode && onToggleSelect) onToggleSelect(video);
    else onPlay(video);
  };

  const showCheckbox = !!onToggleSelect && (selected || selectionMode || IS_TOUCH);

  return (
    <div
      style={{ animationDelay: `${Math.min(index, 14) * 35}ms` }}
      className={cn(
        'cv-card group relative flex flex-col overflow-hidden rounded-xl border bg-surface animate-fade-up transition-all duration-200 hover:-translate-y-1 hover:shadow-xl hover:shadow-accent/10',
        selected ? 'border-accent ring-2 ring-accent/30' : 'border-border hover:border-accent/50',
      )}
    >
      {/* Thumbnail */}
      <div
        className="relative aspect-video cursor-pointer overflow-hidden bg-elevated"
        onClick={onThumbClick}
        onPointerDown={startPress}
        onPointerUp={cancelPress}
        onPointerMove={cancelPress}
        onPointerLeave={cancelPress}
      >
        {!thumbErr ? (
          <img
            src={`/thumb/${video.id}`}
            alt={video.name}
            className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-105"
            onError={() => setThumbErr(true)}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Play className="h-10 w-10 text-text-subtle" />
          </div>
        )}

        {/* Play overlay */}
        <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/30">
          <div className="flex h-11 w-11 scale-90 items-center justify-center rounded-full bg-accent/90 opacity-0 shadow-lg transition-all duration-200 group-hover:scale-100 group-hover:opacity-100">
            <Play className="h-5 w-5 text-white" fill="white" />
          </div>
        </div>

        {/* Selection checkbox (top-left) — bigger tap target on touch */}
        {onToggleSelect && (
          <button
            onClick={e => { e.stopPropagation(); onToggleSelect(video); }}
            className={cn(
              'absolute left-2 top-2 flex items-center justify-center rounded-md border-2 transition-all',
              IS_TOUCH ? 'h-6 w-6' : 'h-5 w-5',
              selected
                ? 'border-accent bg-accent text-white opacity-100'
                : 'border-white/70 bg-black/40 text-transparent',
              showCheckbox ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
            )}
          >
            {selected && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
          </button>
        )}

        {/* Duration badge */}
        {video.duration && (
          <span className="absolute bottom-2 right-2 rounded px-1.5 py-0.5 text-xs font-medium bg-black/70 text-white">
            {formatDuration(video.duration)}
          </span>
        )}
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
