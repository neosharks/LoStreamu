import { healthOf } from './health';
import type { VideoItem, HealthLevel, RepairPlan } from '../types';

// The shape the client sees. Deliberately narrower than VideoItem: absolute
// paths never leave the server, and the per-video issue list is fetched only
// when something is actually wrong with it.

export interface VideoView {
  id: string;
  name: string;
  ext: string;
  folder: string;
  size: number;
  addedAt: number;
  duration?: number;
  width?: number;
  height?: number;
  favorite: boolean;
  /** Absent while the codec probe is still pending — the UI shows no badge. */
  health?: { level: HealthLevel; plan: RepairPlan };
}

export function projectVideo(v: VideoItem, favorite: boolean): VideoView {
  const health = healthOf(v);
  return {
    id: v.id,
    name: v.name,
    ext: v.ext,
    folder: v.folder,
    size: v.size,
    addedAt: v.addedAt,
    duration: v.duration,
    width: v.width,
    height: v.height,
    favorite,
    ...(health && { health: { level: health.level, plan: health.plan } }),
  };
}
