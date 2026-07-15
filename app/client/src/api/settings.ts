import api from './client';
import type { YtDlpVersion } from '../types';

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
  me: () => api.get<{ email: string; isAdmin: boolean }>('/me').then(r => r.data),
  setupState: () => api.get<{ hasAccount: boolean }>('/setup-state').then(r => r.data),
  login: (email: string, password: string) =>
    api.post('/login', { email, password }).then(r => r.data),
  signup: (email: string, password: string) =>
    api.post('/signup', { email, password }).then(r => r.data),
  logout: () => api.post('/logout').then(r => r.data),
  changePassword: (currentPassword: string, email?: string, newPassword?: string) =>
    api.post('/change-password', { currentPassword, email, newPassword }).then(r => r.data),
};

export const usersApi = {
  list: () => api.get<{ email: string }[]>('/users').then(r => r.data),
  create: (email: string, password: string) =>
    api.post('/users', { email, password }).then(r => r.data),
  remove: (email: string) =>
    api.delete(`/users/${encodeURIComponent(email)}`).then(r => r.data),
};
