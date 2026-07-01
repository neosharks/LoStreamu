import type { ReactNode } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Library } from './pages/Library';
import { Login } from './pages/Login';
import { Settings } from './pages/Settings';
import { Downloads } from './pages/Downloads';
import { authApi } from './api/settings';

// Gate protected routes on the session check so the dashboard never mounts
// before we know the user is authenticated (prevents a flash of the dashboard
// before the login screen). While the check runs we show a neutral loader; a
// 401 redirects in-app (no full reload).
function RequireAuth({ children }: { children: ReactNode }) {
  const { isPending, isError } = useQuery({
    queryKey: ['me'],
    queryFn: authApi.me,
    retry: false,
    staleTime: 60_000,
  });

  if (isPending) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg">
        <Loader2 className="h-6 w-6 animate-spin text-accent" />
      </div>
    );
  }
  if (isError) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<RequireAuth><Library /></RequireAuth>} />
      {/* Player state lives in the URL so it survives refresh + shows the name. */}
      <Route path="/watch/:id" element={<RequireAuth><Library /></RequireAuth>} />
      <Route path="/watch/:id/:slug" element={<RequireAuth><Library /></RequireAuth>} />
      <Route path="/login" element={<Login />} />
      <Route path="/downloads" element={<RequireAuth><Downloads /></RequireAuth>} />
      <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
