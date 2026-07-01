import { create } from 'zustand';
import type { DownloadJob, BatchJob } from '../types';

interface DownloadsState {
  jobs: DownloadJob[];
  batches: BatchJob[];
  hydrated: boolean;

  addJob: (job: DownloadJob) => void;
  addBatch: (batch: BatchJob) => void;
  setJobs: (jobs: DownloadJob[]) => void;
  updateJob: (id: string, patch: Partial<DownloadJob>) => void;
  updateBatch: (id: string, patch: Partial<BatchJob>) => void;
  removeJob: (id: string) => void;
  removeBatch: (id: string) => void;
  hydrate: (serverJobs: DownloadJob[], serverBatches: BatchJob[]) => void;
}

export const useDownloadsStore = create<DownloadsState>((set, get) => ({
  jobs: [],
  batches: [],
  hydrated: false,

  addJob: (job) => set(s => ({
    jobs: s.jobs.some(j => j.id === job.id) ? s.jobs : [...s.jobs, job],
  })),

  addBatch: (batch) => set(s => ({
    batches: s.batches.some(b => b.id === batch.id) ? s.batches : [...s.batches, batch],
  })),

  // Replace the whole jobs list from the single whole-queue SSE (server truth).
  setJobs: (jobs) => set({ jobs, hydrated: true }),

  updateJob: (id, patch) => set(s => ({
    jobs: s.jobs.map(j => j.id === id ? { ...j, ...patch } : j),
  })),

  updateBatch: (id, patch) => set(s => ({
    batches: s.batches.map(b => b.id === id ? { ...b, ...patch } : b),
  })),

  removeJob: (id) => set(s => ({ jobs: s.jobs.filter(j => j.id !== id) })),

  removeBatch: (id) => set(s => ({ batches: s.batches.filter(b => b.id !== id) })),

  hydrate: (serverJobs, serverBatches) => {
    const { jobs, batches } = get();
    const existingJobIds = new Set(jobs.map(j => j.id));
    const existingBatchIds = new Set(batches.map(b => b.id));
    set({
      hydrated: true,
      // Keep store items (possibly more up-to-date via SSE), add server items not yet in store
      jobs: [...jobs, ...serverJobs.filter(j => !existingJobIds.has(j.id))],
      batches: [...batches, ...serverBatches.filter(b => !existingBatchIds.has(b.id))],
    });
  },
}));
