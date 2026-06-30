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
