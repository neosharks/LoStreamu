import api from './client';
import type { Person, PersonInVideo, FaceIndexStatus, FaceGrouping, Video } from '../types';

export const facesApi = {
  status: () => api.get<FaceIndexStatus>('/faces/status').then(r => r.data),

  /** Starts in the background; poll status() for progress. */
  scan: (opts: { folder?: string; deep?: boolean; force?: boolean } = {}) =>
    api.post<FaceIndexStatus>('/faces/scan', opts).then(r => r.data),

  stop: () => api.post('/faces/stop').then(r => r.data),

  /** Re-derive people from embeddings already on disk — no re-scanning. */
  regroup: (grouping?: Partial<FaceGrouping>) =>
    api.post<FaceIndexStatus>('/faces/regroup', grouping ?? {}).then(r => r.data),

  reset: () => api.delete('/faces').then(r => r.data),

  people: () => api.get<Person[]>('/faces/people').then(r => r.data),

  videos: (personId: string) =>
    api.get<Video[]>(`/faces/people/${personId}/videos`).then(r => r.data),

  inVideo: (videoId: string) =>
    api.get<PersonInVideo[]>(`/videos/${videoId}/faces`).then(r => r.data),

  rename: (personId: string, name: string) =>
    api.patch(`/faces/people/${personId}`, { name }).then(r => r.data),

  merge: (target: string, sources: string[]) =>
    api.post('/faces/people/merge', { target, sources }).then(r => r.data),

  remove: (personId: string) =>
    api.delete(`/faces/people/${personId}`).then(r => r.data),
};

export const faceThumbUrl = (faceId: string) => `/api/faces/thumb/${faceId}.jpg`;
