import { Router } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import type { Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { APP_DIR, getConfig } from '../config';

const router = Router();

let _updating = false;

function sseLog(res: Response, msg: string, type: 'log' | 'error' | 'done' = 'log') {
  try { res.write(`event: ${type}\ndata: ${JSON.stringify({ msg })}\n\n`); } catch {}
}

// npm writes logs/cache to $HOME — the streamvault service user's home dir may
// not have a writable .npm directory, causing exit code 243. Point npm at /tmp.
const NPM_ENV = {
  ...process.env,
  HOME: '/tmp',
  npm_config_cache: '/tmp/.npm-sv',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
  npm_config_update_notifier: 'false',
};

function runStep(cmd: string, args: string[], cwd: string, res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = cmd === 'npm' ? NPM_ENV : process.env;
    const proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env });
    proc.on('error', reject);
    proc.stdout.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n')) {
        if (line.trim()) sseLog(res, line.trim());
      }
    });
    proc.stderr.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n')) {
        if (line.trim()) sseLog(res, line.trim());
      }
    });
    proc.on('close', (code: number | null) => code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`)));
  });
}

router.get('/app/update/stream', requireAuth, async (req, res) => {
  if (_updating) {
    res.status(409).json({ error: 'Update already in progress' });
    return;
  }
  _updating = true;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const log = (msg: string) => sseLog(res, msg);
  const clientDir = path.join(APP_DIR, 'client');
  const tarPath = '/tmp/sv-update.tar.gz';
  const updateUrl = getConfig().updateUrl ||
    'https://raw.githubusercontent.com/neosharks/LoStreamu/main/streamvault-app.tar.gz';

  try {
    log(`► Downloading latest release from GitHub...`);
    await runStep('curl', ['-fL', '--retry', '3', '-o', tarPath, updateUrl], '/tmp', res);
    log(`✓ Downloaded`);

    log(`► Extracting archive...`);
    await runStep('tar', ['-xzf', tarPath, '-C', APP_DIR], '/', res);
    fs.rmSync(tarPath, { force: true });
    log(`✓ Extracted`);

    log(`► Ensuring Chromium is installed...`);
    try {
      await runStep('sudo', ['apt-get', 'install', '-y', '--no-install-recommends', 'chromium'], '/', res);
      log(`✓ Chromium ready`);
    } catch {
      log(`  (skipped — sudo not available, Chromium may already be installed)`);
    }

    log(`► Ensuring curl-cffi is installed (yt-dlp TLS impersonation)...`);
    try {
      await runStep('pip3', ['install', '-q', '--break-system-packages', 'curl-cffi'], '/', res);
      log(`✓ curl-cffi ready`);
    } catch {
      try {
        await runStep('pip3', ['install', '-q', 'curl-cffi'], '/', res);
        log(`✓ curl-cffi ready`);
      } catch {
        log(`  (skipped — curl-cffi install failed, --impersonate may not work)`);
      }
    }

    log(`► Installing server dependencies...`);
    await runStep('npm', ['install', '--no-fund', '--no-audit', '--loglevel=error'], APP_DIR, res);
    log(`✓ Server deps installed`);

    log(`► Building server (TypeScript)...`);
    await runStep('npm', ['run', 'build:server'], APP_DIR, res);
    log(`✓ Server built`);

    if (fs.existsSync(clientDir)) {
      log(`► Installing client dependencies...`);
      await runStep('npm', ['install', '--no-fund', '--no-audit', '--loglevel=error'], clientDir, res);
      log(`✓ Client deps installed`);

      log(`► Building client (React/Vite)...`);
      await runStep('npm', ['run', 'build'], clientDir, res);
      log(`✓ Client built`);

      log(`► Cleaning client node_modules...`);
      fs.rmSync(path.join(clientDir, 'node_modules'), { recursive: true, force: true });
      log(`✓ Cleaned`);
    }

    log(`► Pruning dev dependencies...`);
    await runStep('npm', ['prune', '--production', '--no-fund', '--loglevel=error'], APP_DIR, res);
    log(`✓ Pruned`);

    sseLog(res, 'Update complete — restarting service in 2 seconds…', 'done');

    // Exit non-zero so systemd's Restart=on-failure triggers a clean restart
    // with the newly compiled code. The service user cannot call systemctl directly.
    setTimeout(() => process.exit(1), 2000);
  } catch (err: any) {
    sseLog(res, `✗ ${err.message}`, 'error');
  } finally {
    _updating = false;
  }
});

export default router;
