export interface Me {
  id: string;
  name: string;
  email: string;
  avatar: string;
  isAdmin: boolean;
  /** Browsers currently trusted for PIN-only login. */
  devices: number;
}

/** What the unauthenticated login screen is allowed to know about a profile. */
export interface Profile {
  id: string;
  name: string;
  avatar: string;
  isAdmin: boolean;
  /** True until this browser has been trusted — email is required alongside the PIN. */
  needsEmail: boolean;
  /** Seconds left on a lockout, 0 when the profile is usable. */
  lockedFor: number;
}

export interface ManagedUser extends Me {
  createdAt: number;
  lockedFor: number;
}

export interface Video {
  id: string;
  name: string;
  ext: string;
  folder: string;
  size: number;
  addedAt: number;
  duration?: number;
  width?: number;
  height?: number;
  /** Starred by the signed-in profile. */
  favorite: boolean;
  /** Absent until the server has probed the file's codecs. */
  health?: { level: HealthLevel; plan: RepairPlan };
}

// ── Playability + repair ──────────────────────────────────────────────────────

/** `warn` plays in some browsers only; `broken` plays nowhere. */
export type HealthLevel = 'ok' | 'warn' | 'broken';
export type RepairPlan = 'none' | 'remux' | 'transcode' | 'unfixable';

export interface VideoHealth {
  level: HealthLevel;
  plan: RepairPlan;
  issues: string[];
}

export interface FolderHealth {
  broken: number;
  warn: number;
  total: number;
}

export type RepairStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface RepairJob {
  id: string;
  videoId: string;
  name: string;
  plan: RepairPlan;
  status: RepairStatus;
  progress: number;
  newVideoId?: string;
  /** True when the file was removed because it could not be repaired. */
  deleted?: boolean;
  error?: string;
  startedAt: number;
}

export interface RepairOptions {
  plan?: RepairPlan;
  /** Delete the video when it cannot be rebuilt into something playable. */
  deleteIfUnfixable?: boolean;
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
  groupId?: string;    // playlist grouping
  groupTitle?: string;
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
  title: string;
  status: BatchStatus;
  paused: boolean;
  done: number;
  total: number;
  concurrency: number;
  items: BatchItem[];
}

export interface PlaylistEntry {
  index: number;
  title: string;
  url?: string;
  duration?: number;
  thumbnail?: string;
}

export interface PlaylistProbe {
  title: string;
  count: number;
  entries: PlaylistEntry[];
}

export interface YtDlpVersion {
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
}
