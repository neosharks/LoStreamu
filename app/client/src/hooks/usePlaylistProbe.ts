import { useEffect, useRef, useState } from 'react';
import { downloadsApi } from '@/api/downloads';
import type { PlaylistEntry } from '../types';

export interface PlaylistProbeState {
  title: string;
  entries: PlaylistEntry[];
  loading: boolean;      // more entries may still arrive
  error: string | null;  // set if reading stopped early; entries so far stay usable
}

const IDLE: PlaylistProbeState = { title: '', entries: [], loading: false, error: null };

// Reads a playlist while the server pages through it: entries arrive in
// batches, so a huge playlist is usable long before it has been read in full.
// `onEntries` sees each new batch (e.g. to auto-select it). url null = idle.
export function usePlaylistProbe(url: string | null, onEntries?: (entries: PlaylistEntry[]) => void) {
  const [state, setState] = useState<PlaylistProbeState>(IDLE);
  const onEntriesRef = useRef(onEntries);
  onEntriesRef.current = onEntries;

  useEffect(() => {
    if (!url) { setState(IDLE); return; }
    setState({ ...IDLE, loading: true });
    const es = new EventSource(downloadsApi.playlistProbeUrl(url), { withCredentials: true });
    const data = (e: Event) => JSON.parse((e as MessageEvent).data);

    es.addEventListener('meta', e => {
      const { title } = data(e);
      setState(s => ({ ...s, title }));
    });
    es.addEventListener('entries', e => {
      const { entries } = data(e) as { entries: PlaylistEntry[] };
      setState(s => ({ ...s, entries: [...s.entries, ...entries] }));
      onEntriesRef.current?.(entries);
    });
    es.addEventListener('done', () => {
      es.close();
      setState(s => ({ ...s, loading: false }));
    });
    es.addEventListener('failed', e => {
      es.close();
      const { error } = data(e);
      setState(s => ({ ...s, loading: false, error }));
    });
    // A dropped connection would make EventSource reconnect and list the whole
    // playlist again from the top — stop instead and keep what arrived.
    es.onerror = () => {
      es.close();
      setState(s => s.loading ? { ...s, loading: false, error: 'Lost connection while reading the playlist' } : s);
    };

    return () => es.close();
  }, [url]);

  return state;
}
