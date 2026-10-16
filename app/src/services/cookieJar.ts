import fs from 'fs';

// A cookie as Chromium reports it, or as a browser-extension JSON export lists it.
export interface JarCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  expires?: number;
}

const HEADER = '# Netscape HTTP Cookie File';
const HTTPONLY_PREFIX = '#HttpOnly_';

export function netscapeLine(c: JarCookie): string {
  const domain = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
  // Session cookies get a month, so a jar written now still works for later downloads.
  const expires = c.expires && c.expires > 0 ? Math.round(c.expires) : Math.floor(Date.now() / 1000) + 86400 * 30;
  return [domain, 'TRUE', c.path || '/', c.secure ? 'TRUE' : 'FALSE', expires, c.name, c.value].join('\t');
}

// Identity of a cookie-file entry (domain + path + name), or null for comments,
// blank lines and malformed entries.
function entryKey(line: string): string | null {
  if (line.startsWith('#') && !line.startsWith(HTTPONLY_PREFIX)) return null;
  const f = line.slice(line.startsWith(HTTPONLY_PREFIX) ? HTTPONLY_PREFIX.length : 0).split('\t');
  if (f.length !== 7) return null;
  return [f[0].replace(/^\./, '').toLowerCase(), f[2], f[5]].join('\t');
}

// One cookies.txt serves every site. Fresh cookies replace only their own
// entries, so fetching one site's cookies never logs you out of another.
export function mergeCookies(existing: string, incoming: JarCookie[]): string {
  const entries = new Map<string, string>();
  for (const line of existing.split(/\r?\n/)) {
    const key = entryKey(line);
    if (key) entries.set(key, line);
  }
  for (const c of incoming) {
    const line = netscapeLine(c);
    entries.set(entryKey(line)!, line);
  }
  return [HEADER, ...entries.values()].join('\n') + '\n';
}

// Cookies from a JSON export (Cookie-Editor, EditThisCookie, …), or null if the
// text is not one.
export function jsonToCookies(text: string): JarCookie[] | null {
  let data: any;
  try { data = JSON.parse(text); } catch { return null; }
  const list = Array.isArray(data) ? data : data?.cookies;
  if (!Array.isArray(list)) return null;
  return list
    .filter(c => c && typeof c.name === 'string' && typeof c.domain === 'string')
    .map(c => ({
      name: c.name,
      value: String(c.value ?? ''),
      domain: c.domain,
      path: c.path,
      secure: !!c.secure,
      expires: Number(c.expirationDate ?? c.expires) || undefined,
    }));
}

// True if `file` can be handed to yt-dlp --cookies. yt-dlp aborts on a JSON
// cookies file, so one pasted browser export would fail every download on every
// site: convert it to Netscape format in place, and leave out anything unusable.
export function prepareCookiesFile(file: string): boolean {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  const body = text.replace(/^﻿/, '').trimStart();
  if (!body.startsWith('[') && !body.startsWith('{')) return true;
  const cookies = jsonToCookies(body);
  if (!cookies) {
    console.warn(`[cookies] ${file} is not a Netscape cookies file or a JSON export — ignoring it`);
    return false;
  }
  fs.writeFileSync(file, mergeCookies('', cookies), { mode: 0o600 });
  console.log(`[cookies] converted JSON cookie export in ${file} to Netscape format`);
  return true;
}
