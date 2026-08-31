/* Runnable drag-and-drop rule tests — `npx tsx tests/drag.test.ts`.
   canDrop() decides, while the pointer is still moving, whether a folder should
   light up as a destination. Getting it wrong either offers a move that the
   server will reject (a folder into its own child) or a move that does nothing. */
import assert from 'assert';
import { canDrop, type DragPayload } from '../client/src/lib/dragRules';

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log('PASS:', name); }
  catch (e) { console.error('FAIL:', name, '\n  ', (e as Error).message); process.exitCode = 1; }
}

const videos = (...sourceFolders: string[]): DragPayload =>
  ({ kind: 'videos', ids: ['a', 'b'], label: '2 videos', sourceFolders });
const folder = (path: string): DragPayload =>
  ({ kind: 'folder', path, label: path.split('/').pop()! });

test('nothing in flight means nothing can be dropped', () => {
  assert.equal(canDrop(null, 'Movies'), false);
});

test('videos can move to any other folder, including the root', () => {
  assert.equal(canDrop(videos('Movies'), 'Shows'), true);
  assert.equal(canDrop(videos('Movies'), ''), true);
  assert.equal(canDrop(videos('Movies'), 'Movies/2024'), true);
});

test('videos already in the destination are not a move', () => {
  assert.equal(canDrop(videos('Movies'), 'Movies'), false);
  assert.equal(canDrop(videos('Movies', 'Movies'), 'Movies'), false);
  assert.equal(canDrop(videos(''), ''), false);
});

test('a mixed selection can still move — some of it is going somewhere', () => {
  assert.equal(canDrop(videos('Movies', 'Shows'), 'Movies'), true);
});

test('a folder cannot be dropped on itself or its own parent', () => {
  assert.equal(canDrop(folder('Movies'), 'Movies'), false);
  assert.equal(canDrop(folder('Movies/2024'), 'Movies'), false, 'already lives there');
  assert.equal(canDrop(folder('Movies'), ''), false, 'root is its parent');
});

test('a folder cannot be dropped inside its own subtree', () => {
  assert.equal(canDrop(folder('Movies'), 'Movies/2024'), false);
  assert.equal(canDrop(folder('Movies'), 'Movies/2024/HD'), false);
});

test('a folder can move to an unrelated folder, or up to the root', () => {
  assert.equal(canDrop(folder('Movies/2024'), 'Shows'), true);
  assert.equal(canDrop(folder('Movies/2024'), ''), true);
  // A sibling whose name merely starts the same is not a descendant.
  assert.equal(canDrop(folder('Movies'), 'Movies2'), true);
});

console.log(`\n${passed} passed`);
