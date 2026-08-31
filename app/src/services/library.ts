import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getConfig, VIDEO_EXTENSIONS, META_CACHE_PATH } from '../config';
import { runMedia } from './exec';
import type { VideoItem, FolderTree } from '../types';

let library: VideoItem[] = [];
// Every directory under the media root, relative and slash-separated. Recorded
// during the scan so the folder tree can show folders that hold no videos yet —
// a folder you just created has to appear, or organising is impossible.
let folders: string[] = [];
let metaCache: Record<string, Partial<VideoItem>> = {};

export function getLibrary(): VideoItem[] {
  return library;
}

export function getMediaRoot(): string {
  return getConfig().mediaDir;
}

function metaCachePath(): string {
  return META_CACHE_PATH;
}

function loadMetaCache(): void {
  try {
    const p = metaCachePath();
    if (fs.existsSync(p)) metaCache = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
}

function saveMetaCache(): void {
  try { fs.writeFileSync(metaCachePath(), JSON.stringify(metaCache)); } catch {}
}

export function makeVideoId(relPath: string): string {
  return crypto.createHash('sha1').update(relPath).digest('hex').slice(0, 16);
}

function relFolder(mediaRoot: string, abs: string): string {
  const rel = path.relative(mediaRoot, abs);
  return rel === '.' ? '' : rel.split(path.sep).join('/');
}

function walkDir(dir: string, mediaRoot: string, dirs: string[]): VideoItem[] {
  const items: VideoItem[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return items; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      dirs.push(relFolder(mediaRoot, abs));
      items.push(...walkDir(abs, mediaRoot, dirs));
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (!VIDEO_EXTENSIONS.has(ext)) continue;
      const rel = path.relative(mediaRoot, abs);
      const id = makeVideoId(rel);
      const stat = fs.statSync(abs);
      // Skip zero-byte files — a truncated/failed download leaves an empty
      // container that would otherwise appear as an unplayable library entry.
      if (stat.size === 0) continue;
      const folder = relFolder(mediaRoot, path.dirname(abs));
      items.push({
        id,
        name: path.basename(e.name, ext),
        ext,
        relPath: rel,
        absPath: abs,
        folder,
        size: stat.size,
        addedAt: Math.floor(stat.birthtimeMs || stat.mtimeMs),
        ...(metaCache[id] || {}),
      });
    }
  }
  return items;
}

export function rescan(): void {
  const root = getMediaRoot();
  try { fs.mkdirSync(root, { recursive: true }); } catch {}
  loadMetaCache();
  const dirs: string[] = [];
  library = walkDir(root, root, dirs);
  folders = dirs.sort();
}

export function getFolders(): string[] {
  return folders;
}

export async function buildMeta(): Promise<void> {
  const items = library.filter(v => !v.duration);
  if (!items.length) return;
  // Probe in parallel — runMedia bounds this to the core count, so 400 new
  // videos get their duration/resolution across all cores instead of serially.
  await Promise.all(items.map(async item => {
    try {
      const { stdout } = await runMedia('ffprobe', [
        '-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format',
        item.absPath,
      ], { timeout: 15000 });
      const d = JSON.parse(stdout);
      const vs = (d.streams || []).find((s: any) => s.codec_type === 'video');
      const dur = parseFloat(d.format?.duration || '0');
      const patch: Partial<VideoItem> = {};
      if (dur > 0) patch.duration = dur;
      if (vs?.width) patch.width = vs.width;
      if (vs?.height) patch.height = vs.height;
      metaCache[item.id] = { ...metaCache[item.id], ...patch };
      Object.assign(item, patch);
    } catch {}
  }));
  saveMetaCache();
}

export function findById(id: string): VideoItem | undefined {
  return library.find(v => v.id === id);
}

// All folders on disk (including empty ones), as sorted relative paths — what
// download destination pickers list. Recorded by the last rescan().
export function listAllFolders(): string[] {
  return folders;
}

export function buildTree(): FolderTree {
  const nodeMap = new Map<string, FolderTree>();

  function getNode(folderPath: string): FolderTree {
    const existing = nodeMap.get(folderPath);
    if (existing) return existing;
    const node: FolderTree = {
      name: folderPath === '' ? '' : folderPath.slice(folderPath.lastIndexOf('/') + 1),
      path: folderPath,
      videoCount: 0,
      totalCount: 0,
      children: [],
    };
    nodeMap.set(folderPath, node);
    // Link into the parent, creating any missing ancestors on the way up.
    if (folderPath !== '') {
      const cut = folderPath.lastIndexOf('/');
      const parent = getNode(cut === -1 ? '' : folderPath.slice(0, cut));
      parent.children.push(node);
    }
    return node;
  }

  const tree = getNode('');
  for (const folder of folders) getNode(folder);
  for (const v of library) getNode(v.folder).videoCount++;

  function finish(node: FolderTree): number {
    node.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    node.totalCount = node.videoCount;
    for (const child of node.children) node.totalCount += finish(child);
    return node.totalCount;
  }
  finish(tree);
  return tree;
}

export function purgeMetaEntry(id: string): void {
  if (metaCache[id]) {
    delete metaCache[id];
    saveMetaCache();
  }
}

// Drop meta-cache entries whose video no longer exists in the library. Call
// after a fresh rescan() so `validIds` reflects what's actually on disk.
// Returns the number of stale entries removed.
export function pruneOrphanMeta(validIds: Set<string>): number {
  let removed = 0;
  for (const id of Object.keys(metaCache)) {
    if (!validIds.has(id)) { delete metaCache[id]; removed++; }
  }
  if (removed) saveMetaCache();
  return removed;
}

export function safePath(relPath: string): string | null {
  const root = getMediaRoot();
  if (!relPath) return null;
  const abs = path.resolve(root, relPath);
  if (!abs.startsWith(root + path.sep) && abs !== root) return null;
  return abs;
}

