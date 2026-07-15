import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Play, Pause, SkipBack, SkipForward, ChevronLeft,
  Volume2, Volume1, VolumeX, Maximize, Minimize,
  PictureInPicture2, Loader2, Trash2,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { usePlayerStore } from '@/stores/playerStore';
import { videosApi, previewApi, type PreviewReady } from '@/api/videos';
import { formatDuration, cn } from '@/lib/utils';

const SEEK_STEP = 10;
const CONTROLS_TIMEOUT = 3000;

export function Player() {
  const { video, playlist, close, next, prev, removeCurrent } = usePlayerStore();
  const qc = useQueryClient();

  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const seekBarRef = useRef<HTMLDivElement>(null);
  const volBarRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();
  const seekingRef = useRef(false);
  const videoIsLandscapeRef = useRef(true); // tracks whether the video file itself is wider than tall
  // Touch devices route all tap-to-play/seek through the gesture handlers below,
  // so the <video> click handler must stay inert (avoids double-firing on tap).
  const isTouchRef = useRef(
    typeof window !== 'undefined' &&
    window.matchMedia('(hover: none) and (pointer: coarse)').matches,
  );

  // Playback state
  const [paused, setPaused] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [volume, setVolumeState] = useState(1);
  const [muted, setMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // UI state
  const [controlsVisible, setControlsVisible] = useState(true);
  const [seeking, setSeeking] = useState(false);
  const [volDragging, setVolDragging] = useState(false);
  const [seekHoverX, setSeekHoverX] = useState<number | null>(null);
  const [flash, setFlash] = useState<{ delta: number; key: number } | null>(null);
  const [buffering, setBuffering] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [preview, setPreview] = useState<PreviewReady | null>(null);
  const [previewStatus, setPreviewStatus] = useState<'generating' | 'ready' | 'error'>('generating');
  const [previewProgress, setPreviewProgress] = useState(0);

  const idx = video && playlist.length ? playlist.findIndex(v => v.id === video.id) : -1;
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < playlist.length - 1;
  const progress = duration > 0 ? currentTime / duration : 0;

  // ── Controls auto-hide ────────────────────────────────────────────────────────
  const revealControls = useCallback(() => {
    setControlsVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      const v = videoRef.current;
      if (v && !v.paused && !seekingRef.current) setControlsVisible(false);
    }, CONTROLS_TIMEOUT);
  }, []);

  // ── Body scroll lock ──────────────────────────────────────────────────────────
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  // ── Fullscreen detection (standard + webkit for older Android/Samsung) ────────
  useEffect(() => {
    const onChange = () =>
      setIsFullscreen(!!(document.fullscreenElement || (document as any).webkitFullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);

  // ── Screen wake lock — keep display on while video plays ─────────────────────
  const wakeLockRef = useRef<any>(null);
  useEffect(() => {
    if (!('wakeLock' in navigator)) return;
    if (!paused) {
      (navigator as any).wakeLock.request('screen')
        .then((wl: any) => { wakeLockRef.current = wl; })
        .catch(() => {});
    } else {
      wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
    }
    return () => { wakeLockRef.current?.release().catch(() => {}); wakeLockRef.current = null; };
  }, [paused]);

  // ── Auto-fullscreen on landscape rotation (Android UX) ───────────────────────
  const autoFsRef = useRef(false);
  useEffect(() => {
    const so = screen.orientation as any;
    if (!so?.addEventListener) return;
    const onOrientationChange = async () => {
      const isLandscape = so.type?.includes('landscape') || so.angle === 90 || so.angle === 270;
      const fsEl = document.fullscreenElement || (document as any).webkitFullscreenElement;
      const el = containerRef.current;
      // Only auto-enter fullscreen on rotation if the video itself is landscape
      if (isLandscape && !fsEl && el && videoIsLandscapeRef.current) {
        try {
          if (el.requestFullscreen) await el.requestFullscreen();
          else if ((el as any).webkitRequestFullscreen) (el as any).webkitRequestFullscreen();
          autoFsRef.current = true;
        } catch {}
      } else if (!isLandscape && autoFsRef.current) {
        try {
          if (document.exitFullscreen) await document.exitFullscreen();
          else if ((document as any).webkitExitFullscreen) (document as any).webkitExitFullscreen();
        } catch {}
        autoFsRef.current = false;
      }
    };
    so.addEventListener('change', onOrientationChange);
    return () => so.removeEventListener('change', onOrientationChange);
  }, []);

  // ── Video event listeners ─────────────────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !video) return;

    const onMeta = () => {
      setDuration(v.duration);
      videoIsLandscapeRef.current = v.videoWidth >= v.videoHeight;
      // Always start from the beginning (no resume-from-last-position).
      v.currentTime = 0;
    };
    const onTime = () => {
      setCurrentTime(v.currentTime);
      if (v.buffered.length) setBufferedEnd(v.buffered.end(v.buffered.length - 1));
    };
    const onPlay = () => { setPaused(false); revealControls(); };
    const onPause = () => { setPaused(true); setControlsVisible(true); clearTimeout(hideTimer.current); };
    const onVol = () => { setVolumeState(v.volume); setMuted(v.muted); };
    const onEnded = () => {
      setPaused(true);
      setControlsVisible(true);
      if (hasNext) setTimeout(next, 800);
    };
    // Buffering spinner — crucial on flaky mobile networks.
    const onWaiting = () => setBuffering(true);
    const onPlaying = () => setBuffering(false);

    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('volumechange', onVol);
    v.addEventListener('ended', onEnded);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('stalled', onWaiting);
    v.addEventListener('loadstart', onWaiting);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('canplay', onPlaying);
    return () => {
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('volumechange', onVol);
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('stalled', onWaiting);
      v.removeEventListener('loadstart', onWaiting);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('canplay', onPlaying);
    };
  }, [video?.id, hasNext, next, revealControls]);

  // ── Scrub-preview frames ──────────────────────────────────────────────────────
  // On play, tell the server to generate the hover-preview frames and poll until
  // they're ready (showing progress). On leaving the video (switch/close) the
  // server deletes them; it also wipes on boot + sweeps idle, so nothing lingers.
  useEffect(() => {
    if (!video) return;
    const id = video.id;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    setPreview(null);
    setPreviewStatus('generating');
    setPreviewProgress(0);

    const poll = async () => {
      try {
        const r = await previewApi.get(id);
        if (!active) return;
        if (r.status === 'ready') { setPreview(r); setPreviewStatus('ready'); }
        else if (r.status === 'generating') { setPreviewProgress(r.progress); timer = setTimeout(poll, 1200); }
        else setPreviewStatus('error');
      } catch { if (active) setPreviewStatus('error'); }
    };
    poll();

    return () => {
      active = false;
      clearTimeout(timer);
      previewApi.remove(id);
    };
  }, [video?.id]);

  // Warm the browser cache once frames are ready so hovering is instant.
  useEffect(() => {
    if (previewStatus !== 'ready' || !preview) return;
    for (let i = 0; i < preview.count; i++) {
      const img = new Image();
      img.src = `${preview.frameBase}${i}.jpg`;
    }
  }, [previewStatus, preview]);

  // ── Actions ───────────────────────────────────────────────────────────────────
  const togglePlay = useCallback(() => {
    const v = videoRef.current; if (!v) return;
    v.paused ? v.play() : v.pause();
  }, []);

  const seekTo = useCallback((frac: number) => {
    const v = videoRef.current; if (!v || !v.duration) return;
    v.currentTime = Math.max(0, Math.min(v.duration, frac * v.duration));
  }, []);

  const seekBy = useCallback((secs: number) => {
    const v = videoRef.current; if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + secs));
    const key = Date.now();
    setFlash({ delta: secs, key });
    setTimeout(() => setFlash(f => f?.key === key ? null : f), 700);
    revealControls();
  }, [revealControls]);

  const setVol = useCallback((frac: number) => {
    const v = videoRef.current; if (!v) return;
    v.volume = Math.max(0, Math.min(1, frac));
    v.muted = frac <= 0;
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current; if (!v) return;
    if (v.muted) { v.muted = false; if (v.volume < 0.05) v.volume = 0.5; }
    else v.muted = true;
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const el = containerRef.current;
    if (!el) return;
    const fsEl = document.fullscreenElement || (document as any).webkitFullscreenElement;
    if (fsEl) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if ((document as any).webkitExitFullscreen) (document as any).webkitExitFullscreen();
      try { (screen.orientation as any)?.unlock?.(); } catch {}
      autoFsRef.current = false;
    } else {
      if (el.requestFullscreen) await el.requestFullscreen();
      else if ((el as any).webkitRequestFullscreen) (el as any).webkitRequestFullscreen();
      // Lock to the orientation that matches the video — landscape for wide videos, portrait for tall
      const targetOrientation = videoIsLandscapeRef.current ? 'landscape' : 'portrait';
      try { await (screen.orientation as any)?.lock?.(targetOrientation); } catch {}
    }
  }, []);

  const togglePiP = useCallback(async () => {
    const v = videoRef.current; if (!v) return;
    document.pictureInPictureElement
      ? await document.exitPictureInPicture()
      : v.requestPictureInPicture?.();
  }, []);

  const doDelete = useCallback(async () => {
    if (!video) return;
    setDeleting(true);
    try {
      await videosApi.delete([video.id]);
      toast.success('Video deleted');
      qc.invalidateQueries({ queryKey: ['videos'] });
      qc.invalidateQueries({ queryKey: ['tree'] });
      setConfirmDelete(false);
      removeCurrent(); // advance to next, or close if it was the last
    } catch {
      toast.error('Delete failed');
    } finally {
      setDeleting(false);
    }
  }, [video, qc, removeCurrent]);

  // ── Seek bar drag (mouse) ─────────────────────────────────────────────────────
  const getFrac = useCallback((e: MouseEvent | React.MouseEvent, bar: HTMLDivElement) => {
    const r = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  }, []);

  const onSeekDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    seekingRef.current = true;
    setSeeking(true);
    if (seekBarRef.current) seekTo(getFrac(e, seekBarRef.current));
  }, [getFrac, seekTo]);

  useEffect(() => {
    if (!seeking) return;
    const onMove = (e: MouseEvent) => { if (seekBarRef.current) seekTo(getFrac(e, seekBarRef.current)); };
    const onUp = () => { setSeeking(false); seekingRef.current = false; };
    const onTouchMove = (e: TouchEvent) => {
      if (!seekBarRef.current) return;
      const touch = e.touches[0];
      const r = seekBarRef.current.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (touch.clientX - r.left) / r.width));
      seekTo(frac);
      setSeekHoverX(frac); // drives the scrub-preview thumbnail on touch
    };
    const onTouchEnd = () => { setSeeking(false); seekingRef.current = false; setSeekHoverX(null); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, [seeking, getFrac, seekTo]);

  // ── Seek bar touch start ──────────────────────────────────────────────────────
  const onSeekTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    e.stopPropagation();
    seekingRef.current = true;
    setSeeking(true);
    if (seekBarRef.current) {
      const touch = e.touches[0];
      const r = seekBarRef.current.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (touch.clientX - r.left) / r.width));
      seekTo(frac);
      setSeekHoverX(frac);
    }
  }, [seekTo]);

  // ── Volume bar drag ───────────────────────────────────────────────────────────
  const onVolDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    setVolDragging(true);
    if (volBarRef.current) setVol(getFrac(e, volBarRef.current));
  }, [getFrac, setVol]);

  useEffect(() => {
    if (!volDragging) return;
    const onMove = (e: MouseEvent) => { if (volBarRef.current) setVol(getFrac(e, volBarRef.current)); };
    const onUp = () => setVolDragging(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, [volDragging, getFrac, setVol]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      switch (e.key) {
        case ' ': case 'k': e.preventDefault(); togglePlay(); break;
        case 'ArrowLeft': case 'j': e.preventDefault(); seekBy(-SEEK_STEP); break;
        case 'ArrowRight': case 'l': e.preventDefault(); seekBy(SEEK_STEP); break;
        case 'ArrowUp': e.preventDefault(); setVol((videoRef.current?.volume ?? 1) + 0.1); break;
        case 'ArrowDown': e.preventDefault(); setVol((videoRef.current?.volume ?? 1) - 0.1); break;
        case 'm': case 'M': toggleMute(); break;
        case 'f': case 'F': toggleFullscreen(); break;
        case 'p': case 'P': togglePiP(); break;
        case 'Escape': close(); break;
        case 'n': case 'N': if (hasNext) next(); break;
        case 'b': case 'B': if (hasPrev) prev(); break;
        default:
          if (e.key >= '0' && e.key <= '9') { e.preventDefault(); seekTo(parseInt(e.key) / 10); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [togglePlay, seekBy, setVol, toggleMute, toggleFullscreen, togglePiP, close, hasNext, hasPrev, next, prev, seekTo]);

  // Timestamp shown above the seek bar while hovering/scrubbing.
  const hoverTime = (seekHoverX ?? 0) * duration;

  // Preview frame for the hovered timestamp.
  const previewFrame = (() => {
    if (!preview || seekHoverX === null || !duration) return null;
    const i = Math.min(preview.count - 1, Math.max(0, Math.floor(hoverTime / preview.interval)));
    return { src: `${preview.frameBase}${i}.jpg`, width: preview.tileW, height: preview.tileH };
  })();
  const previewW = preview?.tileW ?? 160;

  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  // ── Touch: swipe-down to close + double-tap to seek ───────────────────────────
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const lastTap = useRef<{ side: 'left' | 'right' | 'center'; time: number } | null>(null);

  const onTouchStart = (e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    if (!touchStart.current) return;
    const dy = e.changedTouches[0].clientY - touchStart.current.y;
    const dx = e.changedTouches[0].clientX - touchStart.current.x;
    touchStart.current = null;

    // Swipe down to close
    if (dy > 90 && Math.abs(dx) < 60) { close(); return; }

    // Tap (minimal movement) — handle double-tap seek
    if (Math.abs(dx) < 25 && Math.abs(dy) < 25) {
      const touch = e.changedTouches[0];
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = (touch.clientX - rect.left) / rect.width;
      const side: 'left' | 'right' | 'center' = x < 0.33 ? 'left' : x > 0.67 ? 'right' : 'center';
      const now = Date.now();

      if (lastTap.current && now - lastTap.current.time < 300 && lastTap.current.side === side) {
        // Double tap: seek on the sides only. Center is intentionally inert —
        // on mobile, playback toggles ONLY via the on-screen control buttons,
        // never by tapping the video area.
        if (side === 'left') seekBy(-SEEK_STEP);
        else if (side === 'right') seekBy(SEEK_STEP);
        lastTap.current = null;
      } else {
        lastTap.current = { side, time: now };
        revealControls();
      }
    }
  };

  if (!video) return null;

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 flex flex-col bg-black select-none touch-none"
      onMouseMove={revealControls}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* Video */}
      <video
        ref={videoRef}
        key={video.id}
        src={`/stream/${video.id}`}
        className={cn('absolute inset-0 h-full w-full object-contain', !controlsVisible && 'cursor-none')}
        autoPlay
        playsInline
        // Touch taps are handled by the container gesture logic; only wire the
        // click-to-toggle for pointer (mouse) devices to avoid double-firing.
        onClick={() => { if (!isTouchRef.current) togglePlay(); }}
      />

      {/* Buffering spinner */}
      {buffering && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 className="h-12 w-12 animate-spin text-white/90 drop-shadow-lg" />
        </div>
      )}

      {/* Center play button — shown when paused (incl. blocked autoplay). This is
          the ONLY way tapping the middle of the screen starts playback, which is
          what keeps mobile taps from pausing mid-watch. */}
      {paused && !buffering && (
        <button
          onClick={togglePlay}
          className="absolute left-1/2 top-1/2 flex h-20 w-20 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm transition-transform active:scale-90"
          aria-label="Play"
        >
          <Play className="h-10 w-10 translate-x-0.5" fill="currentColor" />
        </button>
      )}

      {/* Center seek flash */}
      {flash && (
        <div
          key={flash.key}
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
          style={{ animation: 'fadeInOut 0.7s ease forwards' }}
        >
          <div className="flex items-center gap-3 rounded-2xl bg-black/60 px-7 py-4 backdrop-blur-md">
            {flash.delta > 0
              ? <SkipForward className="h-10 w-10 text-white" />
              : <SkipBack className="h-10 w-10 text-white" />}
            <span className="text-2xl font-bold text-white">{Math.abs(flash.delta)}s</span>
          </div>
        </div>
      )}

      {/* ── Top bar ──────────────────────────────────────────────────────────────── */}
      <div
        className={cn(
          'absolute inset-x-0 top-0 z-10 flex items-center gap-3 bg-gradient-to-b from-black/80 via-black/30 to-transparent transition-opacity duration-300',
          controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}
        style={{ padding: 'max(env(safe-area-inset-top, 0px), 12px) 16px 12px' }}
      >
        <button
          onClick={close}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/25 active:scale-95 transition-all backdrop-blur-sm"
          aria-label="Close"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>

        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-white leading-tight">{video.name}</p>
          {video.folder && <p className="truncate text-xs text-white/50">{video.folder}</p>}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {playlist.length > 1 && (
            <>
              <button
                onClick={prev}
                disabled={!hasPrev}
                className={cn(
                  'flex h-9 w-9 items-center justify-center rounded-full bg-white/10 backdrop-blur-sm transition-all active:scale-95',
                  hasPrev ? 'text-white hover:bg-white/25' : 'text-white/20 cursor-not-allowed',
                )}
                aria-label="Previous"
              >
                <SkipBack className="h-4 w-4" />
              </button>
              <span className="min-w-14 text-center text-xs font-mono tabular-nums text-white/50">
                {idx + 1} / {playlist.length}
              </span>
              <button
                onClick={next}
                disabled={!hasNext}
                className={cn(
                  'flex h-9 w-9 items-center justify-center rounded-full bg-white/10 backdrop-blur-sm transition-all active:scale-95',
                  hasNext ? 'text-white hover:bg-white/25' : 'text-white/20 cursor-not-allowed',
                )}
                aria-label="Next"
              >
                <SkipForward className="h-4 w-4" />
              </button>
            </>
          )}
          {/* Delete current video */}
          <button
            onClick={() => setConfirmDelete(true)}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-sm transition-all hover:bg-danger/80 active:scale-95"
            aria-label="Delete video"
            title="Delete video"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* ── Delete confirmation (in-player, above all controls) ─────────────────────── */}
      {confirmDelete && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
          onClick={() => !deleting && setConfirmDelete(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <p className="text-base font-semibold text-text-primary">Delete this video?</p>
            <p className="mt-1 truncate text-sm text-text-muted">{video.name}</p>
            <p className="mt-2 text-xs text-danger">This permanently deletes the file. Cannot be undone.</p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                className="rounded-lg px-4 py-2 text-sm font-medium text-text-primary hover:bg-elevated disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={doDelete}
                disabled={deleting}
                className="flex items-center gap-2 rounded-lg bg-danger px-4 py-2 text-sm font-semibold text-white hover:bg-danger/90 disabled:opacity-50"
              >
                {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Bottom controls ───────────────────────────────────────────────────────── */}
      <div
        className={cn(
          'absolute inset-x-0 bottom-0 z-10 flex flex-col gap-3 pt-16 bg-gradient-to-t from-black/85 via-black/40 to-transparent transition-opacity duration-300',
          controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}
        style={{ padding: '4rem 16px max(env(safe-area-inset-bottom, 0px), 20px)' }}
      >

        {/* Seek bar */}
        <div className="relative px-1">
          {/* Preview + timestamp tooltip while hovering / scrubbing */}
          {seekHoverX !== null && (
            <div
              className="absolute bottom-full mb-2 pointer-events-none flex flex-col items-center gap-1"
              style={{
                left: `clamp(${previewW / 2 + 8}px, ${seekHoverX * 100}%, calc(100% - ${previewW / 2 + 8}px))`,
                transform: 'translateX(-50%)',
              }}
            >
              {previewStatus === 'ready' && previewFrame ? (
                <img
                  src={previewFrame.src}
                  width={previewFrame.width}
                  height={previewFrame.height}
                  alt=""
                  draggable={false}
                  className="rounded-lg border border-white/20 bg-black object-cover shadow-2xl"
                />
              ) : previewStatus === 'generating' ? (
                <div
                  className="flex flex-col items-center justify-center gap-1 rounded-lg border border-white/15 bg-black/85 shadow-2xl"
                  style={{ width: previewW, height: Math.round(previewW * 9 / 16) }}
                >
                  <Loader2 className="h-4 w-4 animate-spin text-white/80" />
                  <span className="text-[10px] font-medium text-white/70">
                    Generating preview… {Math.round(previewProgress * 100)}%
                  </span>
                </div>
              ) : null}
              <div className="rounded-lg bg-black/80 px-2 py-1 shadow-xl">
                <p className="text-xs font-mono font-bold text-white tabular-nums">
                  {formatDuration(hoverTime)}
                </p>
              </div>
            </div>
          )}

          {/* Track — taller on mobile for easier touch */}
          <div
            ref={seekBarRef}
            role="slider"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            className="group relative h-2.5 cursor-pointer rounded-full bg-white/20 sm:h-1.5 sm:hover:h-2.5 transition-all duration-150"
            onMouseDown={onSeekDown}
            onTouchStart={onSeekTouchStart}
            onMouseMove={e => {
              const bar = seekBarRef.current; if (!bar) return;
              const r = bar.getBoundingClientRect();
              setSeekHoverX(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
            }}
            onMouseLeave={() => setSeekHoverX(null)}
          >
            {/* Buffered */}
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-white/25"
              style={{ width: `${duration > 0 ? (bufferedEnd / duration) * 100 : 0}%` }}
            />
            {/* Progress */}
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-accent"
              style={{ width: `${progress * 100}%` }}
            />
            {/* Thumb */}
            <div
              className="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-xl opacity-0 group-hover:opacity-100 sm:transition-opacity"
              style={{ left: `${progress * 100}%` }}
            />
          </div>
        </div>

        {/* Controls row */}
        <div className="flex items-center gap-2">
          {/* Seek back */}
          <button
            onClick={() => seekBy(-SEEK_STEP)}
            className="flex h-11 w-11 items-center justify-center rounded-full text-white hover:bg-white/10 active:scale-90 transition-all"
            title={`Rewind ${SEEK_STEP}s  (J / ←)`}
          >
            <SkipBack className="h-7 w-7" />
          </button>

          {/* Play / Pause hero button */}
          <button
            onClick={togglePlay}
            className="flex h-16 w-16 items-center justify-center rounded-full bg-white text-black hover:bg-white/90 active:scale-90 transition-all shadow-2xl"
            title="Play / Pause  (Space / K)"
          >
            {paused
              ? <Play className="h-8 w-8 translate-x-0.5" fill="currentColor" />
              : <Pause className="h-8 w-8" fill="currentColor" />}
          </button>

          {/* Seek forward */}
          <button
            onClick={() => seekBy(SEEK_STEP)}
            className="flex h-11 w-11 items-center justify-center rounded-full text-white hover:bg-white/10 active:scale-90 transition-all"
            title={`Forward ${SEEK_STEP}s  (L / →)`}
          >
            <SkipForward className="h-7 w-7" />
          </button>

          {/* Time */}
          <span className="ml-1 shrink-0 text-sm font-mono tabular-nums text-white/80">
            {formatDuration(currentTime)}
            <span className="text-white/40"> / </span>
            {formatDuration(duration)}
          </span>

          <div className="flex-1" />

          {/* Volume — hidden on mobile (use device hardware buttons) */}
          <div className="group/vol hidden sm:flex items-center gap-1.5">
            <button
              onClick={toggleMute}
              className="flex h-9 w-9 items-center justify-center rounded-full text-white hover:bg-white/10 transition-all"
              title="Mute  (M)"
            >
              <VolumeIcon className="h-5 w-5" />
            </button>
            <div
              ref={volBarRef}
              className="relative h-1.5 w-20 cursor-pointer rounded-full bg-white/20 opacity-0 group-hover/vol:opacity-100 transition-opacity duration-150"
              onMouseDown={onVolDown}
            >
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-white"
                style={{ width: `${muted ? 0 : volume * 100}%` }}
              />
              <div
                className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-lg"
                style={{ left: `${muted ? 0 : volume * 100}%` }}
              />
            </div>
          </div>

          {/* Mute icon — mobile only (no slider, just toggle) */}
          <button
            onClick={toggleMute}
            className="flex h-9 w-9 items-center justify-center rounded-full text-white hover:bg-white/10 transition-all sm:hidden"
            title="Mute"
          >
            <VolumeIcon className="h-5 w-5" />
          </button>

          {/* PiP */}
          <button
            onClick={togglePiP}
            className="hidden sm:flex h-9 w-9 items-center justify-center rounded-full text-white hover:bg-white/10 transition-all"
            title="Picture in Picture  (P)"
          >
            <PictureInPicture2 className="h-5 w-5" />
          </button>

          {/* Fullscreen — larger tap target on mobile */}
          <button
            onClick={toggleFullscreen}
            className="flex h-11 w-11 items-center justify-center rounded-full text-white hover:bg-white/10 active:scale-90 transition-all sm:h-9 sm:w-9"
            title="Fullscreen  (F)"
          >
            {isFullscreen
              ? <Minimize className="h-6 w-6 sm:h-5 sm:w-5" />
              : <Maximize className="h-6 w-6 sm:h-5 sm:w-5" />}
          </button>
        </div>

        {/* Keyboard hint bar — desktop only */}
        <p className="hidden sm:block text-center text-[10px] text-white/20 -mt-1">
          Space/K · J/L ±10s · ↑↓ volume · M mute · F fullscreen · 0–9 seek% · N/B playlist · Esc close
        </p>

        {/* Mobile touch hint — shown briefly then fades */}
        <p className="block sm:hidden text-center text-[10px] text-white/20 -mt-1">
          Double-tap left/right to seek · Swipe down to close
        </p>
      </div>
    </div>
  );
}
