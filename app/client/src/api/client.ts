import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
});

api.interceptors.response.use(
  r => r,
  err => {
    // Redirect to login when a session expires mid-use. Skip the /me probe —
    // the route guard handles that with an in-app (no reload) redirect, which
    // avoids a flash of the dashboard before login.
    const url: string = err.config?.url || '';
    if (
      err.response?.status === 401 &&
      !url.includes('/me') &&
      !window.location.pathname.includes('/login')
    ) {
      window.location.href = '/login';
    }
    return Promise.reject(err);
  },
);

export default api;
