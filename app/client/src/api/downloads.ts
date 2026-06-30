import api from './client';
import type { DownloadJob, BatchJob, PlaylistProbe } from '../types';

export const downloadsApi = {
  list: () => api.get<DownloadJob[]>('/downloads').then(r => r.data),

  start: (url: string, folder: string, filename?: string) =>
    api.post<{ id: string }>('/download', { url, folder, ...(filename && { filename }) }).then(r => r.data),

  pause: (id: string) => api.post(`/download/${id}/pause`).then(r => r.data),

  resume: (id: string) => api.post(`/download/${id}/resume`).then(r => r.data),

  cancel: (id: string) => api.post(`/download/${id}/cancel`).then(r => r.data),

  dismiss: (id: string) => api.post(`/download/${id}/dismiss`).then(r => r.data),

  probePlaylist: (url: string) =>
    api.post<PlaylistProbe>('/playlist/probe', { url }).then(r => r.data),

  startBatch: (payload: {
    url: string;
    folder: string;
    title: string;
    concurrency?: number;
    items: { index: number; title: string; url?: string; thumbnail?: string }[];
  }) => api.post<{ id: string }>('/playlist/download', payload).then(r => r.data),

  listBatches: () => api.get<BatchJob[]>('/batches').then(r => r.data),

  pauseBatch: (id: string) => api.post(`/batch/${id}/pause`).then(r => r.data),

  resumeBatch: (id: string) => api.post(`/batch/${id}/resume`).then(r => r.data),

  stopBatch: (id: string) => api.post(`/batch/${id}/stop`).then(r => r.data),

  cancelBatchItem: (id: string, index: number) =>
    api.post(`/batch/${id}/cancel/${index}`).then(r => r.data),

  dismissBatch: (id: string) => api.post(`/batch/${id}/dismiss`).then(r => r.data),

  upload: (file: File, folder: string, onProgress?: (pct: number) => void) =>
    api.put('/upload', file, {
      params: { folder, filename: file.name },
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      onUploadProgress: e => {
        if (e.total) onProgress?.(Math.round((e.loaded / e.total) * 100));
      },
    }).then(r => r.data),
};
