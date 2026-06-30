import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Play, Pause, SkipBack, SkipForward, ChevronLeft,
  Volume2, Volume1, VolumeX, Maximize, Minimize,
  PictureInPicture2, Gauge,
} from 'lucide-react';
import { usePlayerStore } from '@/stores/playerStore';
import { formatDuration, cn } from '@/lib/utils';

const RESUME_KEY = (id: string) => `sv:pos:${id}`;
const SPRITE_COLS = 5;
const SPRITE_ROWS = 5;
const SPRITE_TOTAL = SPRITE_COLS * SPRITE_ROWS;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const SEEK_STEP = 10;
const CONTROLS_TIMEOUT = 3000;

export function Player() {
  const { video, playlist, close, next, prev } = usePlayerStore();

  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const seekBarRef = useRef<HTMLDivElement>(null);
  const volBarRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();
  const seekingRef = useRef(false);

  // Playback state
  const [paused, setPaused] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [volume, setVolumeState] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // UI state
  const [controlsVisible, setControlsVisible] = useState(true);
  const [seeking, setSeeking] = useState(false);
  const [volDragging, setVolDragging] = useState(false);
  const [seekHoverX, setSeekHoverX] = useState<number | null>(null);
  const [spriteLoaded, setSpriteLoaded] = useState(false);
  const [flash, setFlash] = useState<{ delta: number; key: number } | null>(null);

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

  // ── Sprite preload ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!video) return;
    setSpriteLoaded(false);
    const img = new Image();
    img.onload = () => setSpriteLoaded(true);
    img.src = `/api/videos/${video.id}/sprite.jpg`;
  }, [video?.id]);

  // ── Body scroll lock ──────────────────────────────────────────────────────────
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  // ── Fullscreen detection ──────────────────────────────────────────────────────
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // ── Video event listeners ─────────────────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !video) return;

    const saved = parseFloat(localStorage.getItem(RESUME_KEY(video.id)) ?? '0');

    const onMeta = () => {
      setDuration(v.duration);
      if (saved > 5 && saved < v.duration - 3) v.currentTime = saved;
    };
    const onTime = () => {
      setCurrentTime(v.currentTime);
      if (v.buffered.length) setBufferedEnd(v.buffered.end(v.buffered.length - 1));
    };
    const onPlay = () => { setPaused(false); revealControls(); };
    const onPause = () => { setPaused(true); setControlsVisible(true); clearTimeout(hideTimer.current); };
    const onVol = () => { setVolumeState(v.volume); setMuted(v.muted); };
    const onRate = () => setSpeed(v.playbackRate);
    const onEnded = () => {
      localStorage.removeItem(RESUME_KEY(video.id));
      setPaused(true);
      setControlsVisible(true);
      if (hasNext) setTimeout(next, 800);
    };

    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('volumechange', onVol);
    v.addEventListener('ratechange', onRate);
    v.addEventListener('ended', onEnded);
    return () => {
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('volumechange', onVol);
      v.removeEventListener('ratechange', onRate);
      v.removeEventListener('ended', onEnded);
    };
  }, [video?.id, hasNext, next, revealControls]);

  // ── Save position ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!video) return;
    const id = setInterval(() => {
      const v = videoRef.current;
      if (v && !v.paused && v.currentTime > 5)
        localStorage.setItem(RESUME_KEY(video.id), String(v.currentTime));
    }, 3000);
    return () => clearInterval(id);
  }, [video?.id]);

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

  const cycleSpeed = useCallback(() => {
    const v = videoRef.current; if (!v) return;
    const i = SPEEDS.indexOf(v.playbackRate);
    v.playbackRate = SPEEDS[(i + 1) % SPEEDS.length];
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (!containerRef.current) return;
    document.fullscreenElement
      ? await document.exitFullscreen()
      : await containerRef.current.requestFullscreen();
  }, []);

  const togglePiP = useCallback(async () => {
    const v = videoRef.current; if (!v) return;
    document.pictureInPictureElement
      ? await document.exitPictureInPicture()
      : v.requestPictureInPicture?.();
  }, []);

  // ── Seek bar drag ─────────────────────────────────────────────────────────────
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
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, [seeking, getFrac, seekTo]);

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
        case '<': case ',': {
          const v = videoRef.current; if (!v) break;
          const i = SPEEDS.indexOf(v.playbackRate); if (i > 0) v.playbackRate = SPEEDS[i - 1]; break;
        }
        case '>': case '.': {
          const v = videoRef.current; if (!v) break;
          const i = SPEEDS.indexOf(v.playbackRate); if (i < SPEEDS.length - 1) v.playbackRate = SPEEDS[i + 1]; break;
        }
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

  // ── Sprite hover math ─────────────────────────────────────────────────────────
  const hoverFrame = seekHoverX !== null ? Math.min(SPRITE_TOTAL - 1, Math.floor(seekHoverX * SPRITE_TOTAL)) : 0;
  const hoverCol = hoverFrame % SPRITE_COLS;
  const hoverRow = Math.floor(hoverFrame / SPRITE_COLS);
  const hoverBgX = (hoverCol / (SPRITE_COLS - 1)) * 100;
  const hoverBgY = (hoverRow / (SPRITE_ROWS - 1)) * 100;
  const hoverTime = (seekHoverX ?? 0) * duration;
  const spriteUrl = video ? `/api/videos/${video.id}/sprite.jpg` : '';

  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  // ── Touch: swipe-down to close ────────────────────────────────────────────────
  const touchY = useRef<number | null>(null);
  const onTouchStart = (e: React.TouchEvent) => { touchY.current = e.touches[0].clientY; };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchY.current === null) return;
    if (e.changedTouches[0].clientY - touchY.current > 90) close();
    touchY.current = null;
  };

  if (!video) return null;

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 flex flex-col bg-black select-none"
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
        onClick={togglePlay}
      />

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
      <div className={cn(
        'absolute inset-x-0 top-0 z-10 flex items-center gap-3 px-4 py-3 bg-gradient-to-b from-black/80 via-black/30 to-transparent transition-opacity duration-300',
        controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none',
      )}>
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

        {playlist.length > 1 && (
          <div className="flex items-center gap-2 shrink-0">
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
          </div>
        )}
      </div>

      {/* ── Bottom controls ───────────────────────────────────────────────────────── */}
      <div className={cn(
        'absolute inset-x-0 bottom-0 z-10 flex flex-col gap-3 px-4 pb-5 pt-16 bg-gradient-to-t from-black/85 via-black/40 to-transparent transition-opacity duration-300',
        controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none',
      )}>

        {/* Seek bar */}
        <div className="relative px-1">
          {/* Sprite thumbnail tooltip */}
          {seekHoverX !== null && spriteLoaded && (
            <div
              className="absolute bottom-full mb-3 pointer-events-none"
              style={{
                left: `clamp(80px, ${seekHoverX * 100}%, calc(100% - 80px))`,
                transform: 'translateX(-50%)',
              }}
            >
              <div
                className="overflow-hidden rounded-xl border border-white/20 shadow-2xl"
                style={{ width: 160, height: 90 }}
              >
                <div
                  className="h-full w-full"
                  style={{
                    backgroundImage: `url(${spriteUrl})`,
                    backgroundSize: `${SPRITE_COLS * 100}% ${SPRITE_ROWS * 100}%`,
                    backgroundPosition: `${hoverBgX}% ${hoverBgY}%`,
                    backgroundRepeat: 'no-repeat',
                  }}
                />
              </div>
              <p className="mt-1 text-center text-xs font-mono font-bold text-white tabular-nums drop-shadow-lg">
                {formatDuration(hoverTime)}
              </p>
            </div>
          )}

          {/* Track */}
          <div
            ref={seekBarRef}
            role="slider"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            className="group relative h-1.5 cursor-pointer rounded-full bg-white/20 hover:h-2.5 transition-all duration-150"
            onMouseDown={onSeekDown}
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
              className="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-xl opacity-0 group-hover:opacity-100 transition-opacity"
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

          {/* Speed */}
          <button
            onClick={cycleSpeed}
            className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-sm font-bold text-white hover:bg-white/20 transition-all"
            title="Cycle speed  (< / >)"
          >
            <Gauge className="h-4 w-4" />
            {speed === 1 ? '1×' : `${speed}×`}
          </button>

          {/* Volume */}
          <div className="group/vol flex items-center gap-1.5">
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

          {/* PiP */}
          <button
            onClick={togglePiP}
            className="flex h-9 w-9 items-center justify-center rounded-full text-white hover:bg-white/10 transition-all"
            title="Picture in Picture  (P)"
          >
            <PictureInPicture2 className="h-5 w-5" />
          </button>

          {/* Fullscreen */}
          <button
            onClick={toggleFullscreen}
            className="flex h-9 w-9 items-center justify-center rounded-full text-white hover:bg-white/10 transition-all"
            title="Fullscreen  (F)"
          >
            {isFullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
          </button>
        </div>

        {/* Keyboard hint bar */}
        <p className="hidden sm:block text-center text-[10px] text-white/20 -mt-1">
          Space/K · J/L ±10s · ↑↓ volume · M mute · F fullscreen · 0–9 seek% · N/B playlist · Esc close
        </p>
      </div>
    </div>
  );
}
