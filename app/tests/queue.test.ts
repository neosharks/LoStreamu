/* Runnable queue tests — `npx tsx tests/queue.test.ts` (no test framework needed).
   Drives DownloadQueue with a controllable mock engine so behaviour is
   deterministic and yt-dlp is never touched. */
import assert from 'assert';
import { DownloadQueue } from '../src/services/download/queue';
import { DuplicateError } from '../src/services/download/types';
import type { DownloadEngine, EngineHandle, EngineHooks, EngineResult, QueueItem } from '../src/services/download/types';

// ── Controllable mock engine ─────────────────────────────────────────────────
interface Run { item: QueueItem; hooks: EngineHooks; settle: (r: EngineResult) => void; }
class MockEngine implements DownloadEngine {
  runs: Run[] = [];          // every run ever started (history)
  starts: string[] = [];     // item ids in start order (double-start detector)
  run(item: QueueItem, hooks: EngineHooks): EngineHandle {
    let settle!: (r: EngineResult) => void;
    const done = new Promise<EngineResult>(res => { settle = res; });
    const rec: Run = { item, hooks, settle };
    this.runs.push(rec);
    this.starts.push(item.id);
    return {
      stop: kind => settle({ status: kind === 'pause' ? 'paused' : 'cancelled' }),
      done,
    };
  }
  // The currently-running item's record (concurrency 1 → last started & unsettled).
  active(): Run { return this.runs[this.runs.length - 1]; }
}

const tick = () => new Promise(r => setTimeout(r, 0));
let seq = 0;
const mkQueue = (engine: DownloadEngine, opts = {}) =>
  new DownloadQueue({ engine, persist: false, idFactory: () => `id${++seq}`, ...opts });
const input = (url: string) => ({ url, folder: '', destAbs: '/tmp/x' });

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log('PASS:', name); }
  catch (e) { console.error('FAIL:', name, '\n  ', (e as Error).message); process.exitCode = 1; }
}

(async () => {
  await test('sequential: one active at a time, auto-advances', async () => {
    const eng = new MockEngine();
    const q = mkQueue(eng);
    q.enqueue(input('a')); q.enqueue(input('b')); q.enqueue(input('c'));
    await tick();
    let states = q.list().map(i => i.state);
    assert.deepEqual(states, ['preparing', 'queued', 'queued'], 'only first active');
    assert.equal(eng.starts.length, 1, 'only one engine run started');
    eng.active().settle({ status: 'completed' });
    await tick();
    states = q.list().map(i => i.state);
    assert.deepEqual(states, ['completed', 'preparing', 'queued'], 'advanced to b');
    eng.active().settle({ status: 'completed' });
    await tick();
    eng.active().settle({ status: 'completed' });
    await tick();
    assert.deepEqual(q.list().map(i => i.state), ['completed', 'completed', 'completed']);
    assert.equal(eng.starts.length, 3);
  });

  await test('duplicate: same URL in queue rejected with message', async () => {
    const q = mkQueue(new MockEngine());
    q.enqueue(input('dup'));
    assert.throws(() => q.enqueue(input('dup')), (e: any) =>
      e instanceof DuplicateError && /already downloading|already in the queue/i.test(e.message));
    assert.equal(q.list().length, 1);
  });

  await test('duplicate: rapid repeated adds create exactly one item', async () => {
    const q = mkQueue(new MockEngine());
    let added = 0, dups = 0;
    for (let i = 0; i < 10; i++) {
      try { q.enqueue(input('spam')); added++; } catch { dups++; }
    }
    assert.equal(added, 1); assert.equal(dups, 9);
    assert.equal(q.list().length, 1);
  });

  await test('duplicate: completed URL blocked by default', async () => {
    const eng = new MockEngine();
    const q = mkQueue(eng);
    q.enqueue(input('once')); await tick();
    eng.active().settle({ status: 'completed' }); await tick();
    assert.throws(() => q.enqueue(input('once')), (e: any) =>
      e instanceof DuplicateError && /already been downloaded/i.test(e.message));
  });

  await test('error isolation: a failure does not stop the queue', async () => {
    const eng = new MockEngine();
    const q = mkQueue(eng);
    q.enqueue(input('bad')); q.enqueue(input('good')); await tick();
    eng.active().settle({ status: 'failed', error: 'boom' }); await tick();
    const [a, b] = q.list();
    assert.equal(a.state, 'failed'); assert.equal(a.error, 'boom');
    assert.equal(b.state, 'preparing', 'next item still started');
    eng.active().settle({ status: 'completed' }); await tick();
    assert.equal(q.list()[1].state, 'completed');
  });

  await test('cancel active: stops it and starts the next', async () => {
    const eng = new MockEngine();
    const q = mkQueue(eng);
    const a = q.enqueue(input('a')); q.enqueue(input('b')); await tick();
    q.cancel(a.id); await tick();
    assert.equal(q.get(a.id)!.state, 'cancelled');
    assert.equal(q.list()[1].state, 'preparing', 'b started after cancel');
  });

  await test('cancel queued: removes from run without touching active', async () => {
    const eng = new MockEngine();
    const q = mkQueue(eng);
    q.enqueue(input('a')); const b = q.enqueue(input('b')); await tick();
    q.cancel(b.id); await tick();
    assert.equal(q.get(b.id)!.state, 'cancelled');
    assert.equal(q.list()[0].state, 'preparing', 'a still active');
    assert.equal(eng.starts.length, 1, 'cancelling a queued item never started it');
  });

  await test('retry: failed item re-runs with same metadata', async () => {
    const eng = new MockEngine();
    const q = mkQueue(eng);
    const a = q.enqueue(input('a')); await tick();
    eng.active().settle({ status: 'failed', error: 'net' }); await tick();
    assert.equal(q.get(a.id)!.state, 'failed');
    assert.equal(q.retry(a.id), true);
    await tick();
    assert.equal(q.get(a.id)!.state, 'preparing');
    assert.equal(eng.starts.filter(x => x === a.id).length, 2, 're-ran the same id');
  });

  await test('pause/resume active', async () => {
    const eng = new MockEngine();
    const q = mkQueue(eng);
    const a = q.enqueue(input('a')); q.enqueue(input('b')); await tick();
    q.pause(a.id); await tick();
    assert.equal(q.get(a.id)!.state, 'paused');
    assert.equal(q.list()[1].state, 'preparing', 'b runs while a paused');
    // finish b, then resume a
    eng.active().settle({ status: 'completed' }); await tick();
    q.resume(a.id); await tick();
    assert.equal(q.get(a.id)!.state, 'preparing');
  });

  await test('no double start under a burst of pumps', async () => {
    const eng = new MockEngine();
    const q = mkQueue(eng);
    const a = q.enqueue(input('a'));
    // hammer commands that all call pump() internally
    q.reorder(a.id, 0); q.prioritize(a.id); q.resume(a.id); q.reorder(a.id, 0);
    await tick();
    assert.equal(eng.starts.filter(x => x === a.id).length, 1, 'started exactly once');
  });

  await test('reorder changes which queued item runs next', async () => {
    const eng = new MockEngine();
    const q = mkQueue(eng);
    q.enqueue(input('a')); const b = q.enqueue(input('b')); q.enqueue(input('c')); await tick();
    q.prioritize(b.id);          // move b ahead of the other queued items
    eng.active().settle({ status: 'completed' }); await tick(); // finish a
    assert.equal(q.get(b.id)!.state, 'preparing', 'b jumped the queue');
  });

  await test('clearFinished drops terminal items only', async () => {
    const eng = new MockEngine();
    const q = mkQueue(eng);
    q.enqueue(input('a')); q.enqueue(input('b')); await tick();
    eng.active().settle({ status: 'completed' }); await tick(); // a done, b active
    const removed = q.clearFinished();
    assert.equal(removed, 1);
    assert.equal(q.list().length, 1);
    assert.equal(q.list()[0].url, 'b');
  });

  await test('removeCompleted: finished items leave the queue, failures stay', async () => {
    const eng = new MockEngine();
    const q = mkQueue(eng, { removeCompleted: true });
    const completed: string[] = [];
    q.on('completed', (it: QueueItem) => completed.push(it.id));
    const a = q.enqueue(input('a')); const b = q.enqueue(input('b')); await tick();
    eng.active().settle({ status: 'completed' }); await tick();
    assert.equal(q.get(a.id), undefined, 'a removed once completed');
    assert.deepEqual(completed, [a.id], 'completed event still fires');
    assert.equal(q.get(b.id)!.state, 'preparing', 'next item still auto-starts');
    eng.active().settle({ status: 'failed', error: 'boom' }); await tick();
    assert.equal(q.get(b.id)!.state, 'failed', 'failed items stay for retry');
    assert.doesNotThrow(() => q.enqueue(input('a')), 'a removed completed URL can be re-added');
  });

  await test('title: items are named by their random file name, never the source title', async () => {
    const eng = new MockEngine();
    const q = mkQueue(eng);
    const a = q.enqueue(input('a')); await tick();
    assert.match(a.filename!, /^[0-9a-f]{16}$/);
    assert.equal(a.title, a.filename);
    // A stray title from an engine is ignored: only the thumbnail is taken.
    eng.active().hooks.onPrepared({ thumbUrl: 'https://i/t.jpg', title: 'Original Title' } as never);
    assert.equal(q.get(a.id)!.title, a.filename);
    assert.equal(q.get(a.id)!.thumbUrl, 'https://i/t.jpg');
    const b = q.enqueue({ ...input('b'), filename: 'chosen' });
    assert.equal(b.title, 'chosen');
  });

  console.log(`\n${passed} passed`);
})();
