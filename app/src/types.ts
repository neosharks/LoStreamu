export interface AppConfig {
  port: number;
  mediaDir: string;
  proxy?: string;
  updateUrl?: string;
  /** Legacy email/password fields — read once during migration, then removed. */
  email?: string;
  passwordHash?: string;
}

export interface VideoItem {
  id: string;
  name: string;
  ext: string;
  relPath: string;
  absPath: string;
  folder: string;
  size: number;
  addedAt: number;
  duration?: number;
  width?: number;
  height?: number;
  /** Codec/container facts recorded by buildMeta — what decides playability. */
  vcodec?: string;
  acodec?: string;
  /** MP4 only: true when the moov index sits before the media data. */
  faststart?: boolean;
  /**
   * When ffprobe last read this file. Absent means nobody has looked yet, which
   * is NOT the same as "nothing was found" — only a probed file can be judged.
   */
  probedAt?: number;
}

export interface FolderTree {
  name: string;
  path: string;
  videoCount: number;
  totalCount: number;
  children: FolderTree[];
}

export type DownloadStatus = 'queued' | 'starting' | 'downloading' | 'processing' | 'paused' | 'done' | 'error';
export type BatchStatus = 'running' | 'paused' | 'done' | 'stopped' | 'error';
export type BatchItemStatus = 'pending' | 'downloading' | 'done' | 'error' | 'skipped';

export interface DownloadJob {
  id: string;
  url: string;
  title: string;
  uploader?: string;
  status: DownloadStatus;
  progress: number;
  speed?: string;
  eta?: string;
  folder: string;
  thumbUrl?: string;
  error?: string;
  startedAt: number;
  queuePos?: number; // 0 = active, 1+ = position in queue; absent when done/error
}

export interface BatchItem {
  index: number;
  title: string;
  url?: string;
  thumbnail?: string;
  status: BatchItemStatus;
  progress: number;
  speed?: string;
  eta?: string;
  error?: string;
}

export interface BatchJob {
  id: string;
  url: string;
  title: string;
  folder: string;
  items: BatchItem[];
  done: number;
  total: number;
  status: BatchStatus;
  paused: boolean;
  concurrency: number;
  startedAt: number;
  archive: string;
  _procs?: Map<number, import('child_process').ChildProcess>;
  _subs?: Set<import('express').Response>;
  _stopReq?: boolean;
  _lastStartMs?: number;
}

export interface PlaylistEntry {
  index: number;
  title: string;
  url?: string;
  duration?: number;
  thumbnail?: string;
}

export interface PlaylistProbeResult {
  title: string;
  count: number;
  entries: PlaylistEntry[];
}

export interface YtDlpVersionInfo {
  current: string | null;
  latest: string | null;
  outdated: boolean;
}

export interface ServerStats {
  videos: number;
  libraryBytes: number;
  disk?: { used: number; total: number };
  mem?: { used: number; total: number };
  cpu: { count: number; load: number[] };
  uptime: { process: number; system: number };
  node: string;
  platform: string;
  activeDownloads: number;
  ytdlp?: YtDlpVersionInfo;
}

// ── Playability + repair ──────────────────────────────────────────────────────

/** `warn` plays in some browsers only; `broken` plays nowhere. */
export type HealthLevel = 'ok' | 'warn' | 'broken';
export type RepairPlan = 'none' | 'remux' | 'transcode' | 'unfixable';

export interface VideoHealth {
  level: HealthLevel;
  plan: RepairPlan;
  /** Plain-language reasons, shown verbatim in the UI. */
  issues: string[];
}

export type RepairStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface RepairJob {
  id: string;
  videoId: string;
  name: string;
  plan: RepairPlan;
  status: RepairStatus;
  /** 0-100, from ffmpeg's own position reporting. */
  progress: number;
  /** Set once the repair finishes — the id changes when the extension does. */
  newVideoId?: string;
  error?: string;
  startedAt: number;
}

// ── Faces ─────────────────────────────────────────────────────────────────────

export interface Person {
  id: string;
  /** Empty until the user names them; the UI shows "Person N" instead. */
  name: string;
  /** Face id whose thumbnail represents this person. */
  cover: string;
  videoCount: number;
  faceCount: number;
}

export interface FaceIndexStatus {
  running: boolean;
  /** Videos already processed in the current (or last) run. */
  done: number;
  total: number;
  /** Name of the video being scanned right now. */
  current?: string;
  people: number;
  /** Set when the run stopped early — a missing model, no ffmpeg, etc. */
  error?: string;
  /** Model download progress, 0-100, while the first run fetches them. */
  modelProgress?: number;
  finishedAt?: number;
}
