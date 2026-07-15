import api from './client';
import type { Video, FolderTree, ServerStats } from '../types';

export interface PreviewReady {
  status: 'ready';
  count: number;
  interval: number;
  tileW: number;
  tileH: number;
  frameBase: string; // append `${index}.jpg`
}
export type PreviewResponse =
  | PreviewReady
  | { status: 'generating'; progress: number }
  | { status: 'error' };

export const previewApi = {
  get: (id: string) => api.get<PreviewResponse>(`/preview/${id}`).then(r => r.data),
  remove: (id: string) => api.delete(`/preview/${id}`).then(r => r.data).catch(() => {}),
};

export const videosApi = {
  list: (folder = '', all = false) =>
    api.get<Video[]>('/videos', { params: { folder, ...(all && { all: '1' }) } }).then(r => r.data),

  info: (id: string) => api.get<Video>(`/videos/${id}/info`).then(r => r.data),

  tree: () => api.get<FolderTree>('/tree').then(r => r.data),

  allFolders: () => api.get<string[]>('/folders/all').then(r => r.data),

  stats: () => api.get<ServerStats>('/stats').then(r => r.data),

  rescan: () => api.post('/rescan').then(r => r.data),

  rename: (id: string, name: string) =>
    api.patch(`/videos/${id}`, { name }).then(r => r.data),

  delete: (ids: string[]) =>
    api.delete('/videos', { data: { ids } }).then(r => r.data),

  move: (ids: string[], folder: string) =>
    api.post('/videos/move', { ids, folder }).then(r => r.data),

  createFolder: (name: string, parent = '') =>
    api.post('/folders', { name, parent }).then(r => r.data),

  renameFolder: (folder: string, name: string) =>
    api.patch('/folders', { folder, name }).then(r => r.data),

  deleteFolder: (folder: string) =>
    api.delete('/folders', { data: { folder } }).then(r => r.data),

  moveFolder: (folder: string, dest: string) =>
    api.post('/folders/move', { folder, dest }).then(r => r.data),

  archiveFolders: () =>
    api.get<string[]>('/folders/archives').then(r => r.data),
};
