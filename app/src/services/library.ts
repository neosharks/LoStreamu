import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getConfig, VIDEO_EXTENSIONS, APP_DIR } from '../config';
import { runMedia } from './exec';
import type { VideoItem, FolderTree } from '../types';

let library: VideoItem[] = [];
let metaCache: Record<string, Partial<VideoItem>> = {};

export function getLibrary(): VideoItem[] {
  return library;
}

export function getMediaRoot(): string {
  return getConfig().mediaDir;
}

function metaCachePath(): string {
  return path.join(APP_DIR, 'meta-cache.json');
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

function walkDir(dir: string, mediaRoot: string): VideoItem[] {
  const items: VideoItem[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return items; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      items.push(...walkDir(abs, mediaRoot));
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (!VIDEO_EXTENSIONS.has(ext)) continue;
      const rel = path.relative(mediaRoot, abs);
      const id = makeVideoId(rel);
      const stat = fs.statSync(abs);
      const folder = path.relative(mediaRoot, path.dirname(abs));
      items.push({
        id,
        name: path.basename(e.name, ext),
        ext,
        relPath: rel,
        absPath: abs,
        folder: folder === '.' ? '' : folder,
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
  library = walkDir(root, root);
}

export async function buildMeta(): Promise<void> {
  const items = library.filter(v => !v.duration);
  for (const item of items) {
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
  }
  if (items.length) saveMetaCache();
}

export function findById(id: string): VideoItem | undefined {
  return library.find(v => v.id === id);
}

export function buildTree(): FolderTree {
  const root = getMediaRoot();
  const nodeMap = new Map<string, FolderTree>();

  function getNode(folderPath: string): FolderTree {
    if (nodeMap.has(folderPath)) return nodeMap.get(folderPath)!;
    const node: FolderTree = {
      name: folderPath === '' ? '' : path.basename(folderPath),
      path: folderPath,
      videoCount: 0,
      totalCount: 0,
      children: [],
    };
    nodeMap.set(folderPath, node);
    return node;
  }

  for (const v of library) {
    const parts = v.folder ? v.folder.split(path.sep) : [];
    let cur = '';
    getNode('');
    for (const part of parts) {
      const parent = cur;
      cur = cur ? `${cur}/${part}` : part;
      const node = getNode(cur);
      const parentNode = getNode(parent);
      if (!parentNode.children.find(c => c.path === cur)) {
        parentNode.children.push(node);
      }
    }
    getNode(v.folder).videoCount++;
  }

  function propagate(node: FolderTree): number {
    node.totalCount = node.videoCount;
    for (const child of node.children) node.totalCount += propagate(child);
    return node.totalCount;
  }
  const tree = getNode('');
  propagate(tree);
  return tree;
}

export function purgeMetaEntry(id: string): void {
  if (metaCache[id]) {
    delete metaCache[id];
    saveMetaCache();
  }
}

export function safePath(relPath: string): string | null {
  const root = getMediaRoot();
  if (!relPath) return null;
  const abs = path.resolve(root, relPath);
  if (!abs.startsWith(root + path.sep) && abs !== root) return null;
  return abs;
}

export function pruneEmptyDirs(dir: string): void {
  const root = getMediaRoot();
  let cur = dir;
  while (cur !== root && cur.startsWith(root)) {
    try {
      const entries = fs.readdirSync(cur);
      if (entries.length > 0) break;
      fs.rmdirSync(cur);
      cur = path.dirname(cur);
    } catch { break; }
  }
}
