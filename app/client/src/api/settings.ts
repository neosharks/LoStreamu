import api from './client';
import type { YtDlpVersion, Me, Profile, ManagedUser } from '../types';
import type { AvatarKey } from '../lib/avatars';

export interface AppVersion {
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
}

export interface CleanupResult {
  ok: boolean;
  removedFiles: number;
  freedBytes: number;
  thumbnails: { removedFiles: number; freedBytes: number };
  tempFiles: { removedFiles: number; freedBytes: number };
  metaEntries: number;
  emptyFolders: number;
}

export interface RegenResult {
  ok: boolean;
  total: number;
  generated: number;
  skipped: number;
  failed: number;
}

export const settingsApi = {
  getProxy: () => api.get<{ proxy: string }>('/settings').then(r => r.data),
  setProxy: (proxy: string) => api.post('/settings', { proxy }).then(r => r.data),
  appVersion: () => api.get<AppVersion>('/app/version').then(r => r.data),
  ytdlpVersion: () => api.get<YtDlpVersion>('/ytdlp/version').then(r => r.data),
  ytdlpUpdate: () => api.post<{ ok: boolean; version: string }>('/ytdlp/update').then(r => r.data),
  appUpdateUrl: () => `${api.defaults.baseURL}/app/update/stream`,
  cleanJunk: () => api.post<CleanupResult>('/maintenance/clean').then(r => r.data),
  regenerateThumbnails: () =>
    api.post<RegenResult>('/maintenance/thumbnails').then(r => r.data),
};

export const authApi = {
  me: () => api.get<Me>('/me').then(r => r.data),
  setupState: () => api.get<{ hasAccount: boolean }>('/setup-state').then(r => r.data),
  profiles: () => api.get<{ profiles: Profile[] }>('/profiles').then(r => r.data.profiles),
  setup: (input: { name: string; email: string; pin: string; avatar?: AvatarKey }) =>
    api.post<{ ok: boolean; user: Me }>('/setup', input).then(r => r.data),
  login: (input: { userId: string; pin: string; email?: string; remember?: boolean }) =>
    api.post<{ ok: boolean; user: Me }>('/login', input).then(r => r.data),
  logout: () => api.post('/logout').then(r => r.data),
  updateProfile: (input: {
    name?: string; avatar?: AvatarKey; email?: string; currentPin?: string; newPin?: string;
  }) => api.post<{ ok: boolean; user: Me }>('/profile', input).then(r => r.data),
  forgetDevices: () => api.post('/profile/forget-devices').then(r => r.data),
};

export const usersApi = {
  list: () => api.get<ManagedUser[]>('/users').then(r => r.data),
  create: (input: {
    name: string; email: string; pin: string; avatar?: AvatarKey; isAdmin?: boolean;
  }) => api.post('/users', input).then(r => r.data),
  update: (id: string, input: {
    name?: string; email?: string; avatar?: AvatarKey; isAdmin?: boolean; pin?: string;
  }) => api.patch(`/users/${id}`, input).then(r => r.data),
  unlock: (id: string) => api.post(`/users/${id}/unlock`).then(r => r.data),
  remove: (id: string) => api.delete(`/users/${id}`).then(r => r.data),
};
