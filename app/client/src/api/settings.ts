import api from './client';
import type { YtDlpVersion } from '../types';

export interface AppVersion {
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
}

export const settingsApi = {
  getProxy: () => api.get<{ proxy: string }>('/settings').then(r => r.data),
  setProxy: (proxy: string) => api.post('/settings', { proxy }).then(r => r.data),
  appVersion: () => api.get<AppVersion>('/app/version').then(r => r.data),
  ytdlpVersion: () => api.get<YtDlpVersion>('/ytdlp/version').then(r => r.data),
  ytdlpUpdate: () => api.post<{ ok: boolean; version: string }>('/ytdlp/update').then(r => r.data),
  appUpdateUrl: () => `${api.defaults.baseURL}/app/update/stream`,
};

export const authApi = {
  me: () => api.get<{ email: string }>('/me').then(r => r.data),
  setupState: () => api.get<{ hasAccount: boolean }>('/setup-state').then(r => r.data),
  login: (email: string, password: string) =>
    api.post('/login', { email, password }).then(r => r.data),
  signup: (email: string, password: string) =>
    api.post('/signup', { email, password }).then(r => r.data),
  logout: () => api.post('/logout').then(r => r.data),
  changePassword: (currentPassword: string, email?: string, newPassword?: string) =>
    api.post('/change-password', { currentPassword, email, newPassword }).then(r => r.data),
};
