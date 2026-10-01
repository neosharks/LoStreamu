/* Runnable face-maths tests — `npx tsx tests/faces.test.ts` (no framework).
   Covers the pure geometry the face scanner is built on: anchor decoding, the
   overlap filter, the alignment transform that puts every face in the same pose
   before it is embedded, and the vector maths that decides who is who. The ONNX
   models themselves are not exercised here — these are the parts that are wrong
   silently if they are wrong at all. */
import assert from 'assert';
import {
  letterbox, anchorCenters, distanceToBox, distanceToPoints, iou, nms,
  similarityTransform, invertAffine, warpAffine, cropSquare,
  l2Normalize, cosine, mergeCentroid, packEmbedding, unpackEmbedding, ARCFACE_TEMPLATE,
  type Detection, type RgbImage,
} from '../src/services/faces/geometry';
import { clusterFaces, type FaceVector } from '../src/services/faces/cluster';
import { sampleTimes, pickSamples } from '../src/services/faces';

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log('PASS:', name); }
  catch (e) { console.error('FAIL:', name, '\n  ', (e as Error).message); process.exitCode = 1; }
}

function solidImage(width: number, height: number, rgb: [number, number, number]): RgbImage {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    data[i * 3] = rgb[0]; data[i * 3 + 1] = rgb[1]; data[i * 3 + 2] = rgb[2];
  }
  return { data, width, height };
}

const detection = (x1: number, y1: number, x2: number, y2: number, score: number): Detection =>
  ({ box: { x1, y1, x2, y2 }, score, landmarks: [] });

(async () => {
  await test('letterbox: fits a wide frame and reports the scale back', () => {
    const { image, scale } = letterbox(solidImage(1280, 720, [10, 20, 30]), 640);
    assert.equal(image.width, 640);
    assert.equal(image.height, 640);
    assert.equal(scale, 0.5);
    // Top-left holds the frame, the bottom strip is the black padding.
    assert.equal(image.data[0], 10);
    assert.equal(image.data[(639 * 640 + 320) * 3], 0);
  });

  await test('anchorCenters: two anchors per cell, stepping by the stride', () => {
    const centers = anchorCenters(640, 32, 2);
    assert.equal(centers.length, 20 * 20 * 2 * 2);
    assert.deepEqual([centers[0], centers[1]], [0, 0]);
    assert.deepEqual([centers[2], centers[3]], [0, 0]);   // same cell, second anchor
    assert.deepEqual([centers[4], centers[5]], [32, 0]);  // next cell along
  });

  await test('distanceToBox: edge distances are in stride units', () => {
    const box = distanceToBox(100, 100, [1, 2, 3, 4], 0, 8);
    assert.deepEqual(box, { x1: 92, y1: 84, x2: 124, y2: 132 });
  });

  await test('distanceToPoints: five landmarks come back in frame pixels', () => {
    const pts = distanceToPoints(50, 50, [1, 1, 2, 2, 0, 0, -1, -1, -2, -2], 0, 10, 5);
    assert.deepEqual(pts[0], [60, 60]);
    assert.deepEqual(pts[2], [50, 50]);
    assert.deepEqual(pts[4], [30, 30]);
  });

  await test('iou: identical boxes overlap fully, separate boxes not at all', () => {
    const a = { x1: 0, y1: 0, x2: 10, y2: 10 };
    assert.equal(iou(a, a), 1);
    assert.equal(iou(a, { x1: 20, y1: 20, x2: 30, y2: 30 }), 0);
    assert.ok(Math.abs(iou(a, { x1: 5, y1: 0, x2: 15, y2: 10 }) - 1 / 3) < 1e-6);
  });

  await test('nms: the best score wins, near-duplicates are dropped', () => {
    const kept = nms([
      detection(0, 0, 100, 100, 0.9),
      detection(5, 5, 105, 105, 0.8),   // same face, found again
      detection(300, 300, 400, 400, 0.7),
    ], 0.4);
    assert.equal(kept.length, 2);
    assert.equal(kept[0]?.score, 0.9);
    assert.equal(kept[1]?.score, 0.7);
  });

  await test('similarityTransform: lands the landmarks on the template', () => {
    // A face at twice the template's size, rotated, offset — the hard case.
    const angle = 0.3;
    const scale = 2;
    const src = ARCFACE_TEMPLATE.map(([x, y]) => [
      scale * (Math.cos(angle) * x - Math.sin(angle) * y) + 40,
      scale * (Math.sin(angle) * x + Math.cos(angle) * y) + 25,
    ] as [number, number]);
    const m = similarityTransform(src, ARCFACE_TEMPLATE);
    for (let i = 0; i < src.length; i++) {
      const x = m[0] * src[i]![0] + m[1] * src[i]![1] + m[2];
      const y = m[3] * src[i]![0] + m[4] * src[i]![1] + m[5];
      assert.ok(Math.abs(x - ARCFACE_TEMPLATE[i]![0]) < 1e-6, `x ${i}`);
      assert.ok(Math.abs(y - ARCFACE_TEMPLATE[i]![1]) < 1e-6, `y ${i}`);
    }
  });

  await test('similarityTransform: degenerate landmarks fall back to a shift', () => {
    const same: Array<[number, number]> = Array.from({ length: 5 }, () => [10, 10]);
    const m = similarityTransform(same, ARCFACE_TEMPLATE);
    assert.ok(Number.isFinite(m[0]) && Number.isFinite(m[2]));
  });

  await test('invertAffine: round-trips a point', () => {
    const m = similarityTransform(
      [[0, 0], [10, 0], [5, 5], [0, 10], [10, 10]],
      [[2, 3], [22, 3], [12, 13], [2, 23], [22, 23]],
    );
    const inv = invertAffine(m);
    const x = m[0] * 7 + m[1] * 4 + m[2];
    const y = m[3] * 7 + m[4] * 4 + m[5];
    assert.ok(Math.abs((inv[0] * x + inv[1] * y + inv[2]) - 7) < 1e-6);
    assert.ok(Math.abs((inv[3] * x + inv[4] * y + inv[5]) - 4) < 1e-6);
  });

  await test('warpAffine: samples inside the source and blacks out the rest', () => {
    const src = solidImage(20, 20, [200, 100, 50]);
    const out = warpAffine(src, [1, 0, 0, 0, 1, 0], 40, 40);
    assert.deepEqual([out.data[0], out.data[1], out.data[2]], [200, 100, 50]);
    // (30, 30) maps outside a 20×20 source, so it stays black.
    const far = (30 * 40 + 30) * 3;
    assert.deepEqual([out.data[far], out.data[far + 1], out.data[far + 2]], [0, 0, 0]);
  });

  await test('cropSquare: produces the requested square around the box', () => {
    const out = cropSquare(solidImage(200, 200, [9, 9, 9]), { x1: 50, y1: 50, x2: 90, y2: 110 }, 160);
    assert.equal(out.width, 160);
    assert.equal(out.height, 160);
    const middle = (80 * 160 + 80) * 3;
    assert.equal(out.data[middle], 9);
  });

  await test('l2Normalize: returns a unit vector', () => {
    const v = l2Normalize([3, 4]);
    assert.ok(Math.abs(Math.hypot(v[0]!, v[1]!) - 1) < 1e-6);
    // An all-zero vector must not produce NaN.
    assert.equal(l2Normalize([0, 0])[0], 0);
  });

  await test('cosine: 1 for the same direction, 0 for perpendicular', () => {
    assert.ok(Math.abs(cosine(l2Normalize([1, 2, 3]), l2Normalize([1, 2, 3])) - 1) < 1e-6);
    assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-6);
  });

  await test('mergeCentroid: a new face pulls the centroid, weighted by history', () => {
    const a = l2Normalize([1, 0]);
    const b = l2Normalize([0, 1]);
    const halfway = mergeCentroid(a, 1, b);
    assert.ok(Math.abs(halfway[0]! - halfway[1]!) < 1e-6);   // one each way = midpoint
    const barelyMoved = mergeCentroid(a, 99, b);
    assert.ok(barelyMoved[0]! > 0.99);
    assert.ok(Math.abs(Math.hypot(barelyMoved[0]!, barelyMoved[1]!) - 1) < 1e-6);
  });

  await test('sampleTimes: spreads frames across the video and stays inside it', () => {
    const times = sampleTimes(600);
    assert.equal(times.length, 60);
    assert.ok(times[0]! > 0);
    assert.ok(times[times.length - 1]! < 600);
    for (let i = 1; i < times.length; i++) assert.ok(times[i]! > times[i - 1]!);
  });

  await test('sampleTimes: a short clip still gets at least one frame', () => {
    assert.equal(sampleTimes(3).length, 1);
    assert.equal(sampleTimes(0).length, 1);
  });

  // ── Embedding storage ──────────────────────────────────────────────────────

  await test('packEmbedding: survives the round trip with cosine intact', () => {
    const v = l2Normalize(Array.from({ length: 512 }, (_, i) => Math.sin(i * 0.37)));
    const back = unpackEmbedding(packEmbedding(v));
    assert.equal(back.length, 512);
    // One byte per dimension, so the vector moves a little — but nowhere near
    // enough to matter against a grouping threshold.
    assert.ok(cosine(v, back) > 0.9999, `cosine after round trip: ${cosine(v, back)}`);
  });

  // ── Grouping ───────────────────────────────────────────────────────────────
  // Synthetic faces: a "person" is a direction in the vector space, and their
  // faces are that direction nudged about, the way pose and lighting nudge a
  // real embedding.

  const rand = (seed: number) => { let x = seed; return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648; };

  function personVectors(id: number, count: number, spread: number, seed = 1): Float32Array[] {
    const next = rand(seed + id * 977);
    const base = l2Normalize(Array.from({ length: 64 }, () => next() - 0.5));
    return Array.from({ length: count }, () =>
      l2Normalize(Array.from(base, v => v + (next() - 0.5) * spread)));
  }

  const asFaces = (groups: Float32Array[][]): FaceVector[] =>
    groups.flatMap((vs, g) => vs.map((embedding, i) => ({ id: `p${g}-f${i}`, embedding })));

  await test('clusterFaces: two separate people come out as two people', () => {
    const faces = asFaces([personVectors(0, 6, 0.25), personVectors(1, 6, 0.25)]);
    const { groups, count } = clusterFaces(faces, { threshold: 0.35, minFaces: 2 });
    assert.equal(count, 2);
    const a = new Set(faces.slice(0, 6).map(f => groups.get(f.id)));
    const b = new Set(faces.slice(6).map(f => groups.get(f.id)));
    assert.equal(a.size, 1, 'first person split');
    assert.equal(b.size, 1, 'second person split');
    assert.notEqual([...a][0], [...b][0], 'two people were fused');
  });

  await test('clusterFaces: a person photographed across a drifting range stays one person', () => {
    // The exact case that broke the first version: each shot resembles the next,
    // but the first and last are far apart. Matching against an average splits
    // them; matching against individual faces keeps the chain together.
    const next = rand(7);
    const base = l2Normalize(Array.from({ length: 64 }, () => next() - 0.5));
    const drift = l2Normalize(Array.from({ length: 64 }, () => next() - 0.5));
    const chain = Array.from({ length: 8 }, (_, k) =>
      l2Normalize(Array.from(base, (v, i) => v + drift[i]! * k * 0.22)));
    assert.ok(cosine(chain[0]!, chain[7]!) < 0.6, 'ends should be far apart for this test to mean anything');

    const faces = chain.map((embedding, i) => ({ id: `c${i}`, embedding }));
    const { count } = clusterFaces(faces, { threshold: 0.5, minFaces: 2 });
    assert.equal(count, 1, 'the chain was split into several people');
  });

  await test('clusterFaces: minFaces decides whether a thin cluster is a person', () => {
    // Two faces that resemble each other and nothing else. Whether that counts
    // as a person is exactly what minFaces is for.
    const pair = personVectors(3, 2, 0.05);
    const crowd = personVectors(4, 6, 0.2);
    const faces = asFaces([pair, crowd]);
    assert.equal(clusterFaces(faces, { threshold: 0.5, minFaces: 2 }).count, 2, 'a pair should be a person at minFaces 2');
    const strict = clusterFaces(faces, { threshold: 0.5, minFaces: 3 });
    assert.equal(strict.groups.get('p0-f0'), undefined, 'a pair should not anchor a person at minFaces 3');
  });

  await test('clusterFaces: a lone face is not a person', () => {
    const faces = [...asFaces([personVectors(0, 5, 0.2)]), { id: 'loner', embedding: personVectors(9, 1, 0)[0]! }];
    const { groups, count } = clusterFaces(faces, { threshold: 0.4, minFaces: 2 });
    assert.equal(count, 1);
    assert.equal(groups.get('loner'), undefined, 'a single unexplained face became a person');
  });

  await test('clusterFaces: a manual merge beats the geometry', () => {
    const faces = asFaces([personVectors(0, 5, 0.2), personVectors(1, 5, 0.2)]);
    const linked = clusterFaces(faces, { threshold: 0.4, minFaces: 2 }, [['p0-f0', 'p1-f0']]);
    assert.equal(linked.count, 1, 'a must-link pair was ignored');
  });

  await test('clusterFaces: an empty library groups into nobody', () => {
    const { groups, count } = clusterFaces([], { threshold: 0.4, minFaces: 2 });
    assert.equal(count, 0);
    assert.equal(groups.size, 0);
  });

  await test('pickSamples: prefers clear frames spread across the video', () => {
    const samples = [
      { embedding: new Float32Array(1), score: 0.9, at: 10 },
      { embedding: new Float32Array(1), score: 0.88, at: 10.5 },  // nearly the same moment
      { embedding: new Float32Array(1), score: 0.8, at: 60 },
      { embedding: new Float32Array(1), score: 0.7, at: 120 },
    ];
    const picked = pickSamples(samples, 3, 4);
    assert.deepEqual(picked.map(s => s.at), [10, 60, 120]);
  });

  await test('pickSamples: a short clip still yields frames when none are far apart', () => {
    const samples = [
      { embedding: new Float32Array(1), score: 0.9, at: 1 },
      { embedding: new Float32Array(1), score: 0.8, at: 1.2 },
    ];
    assert.equal(pickSamples(samples, 2, 10).length, 2);
  });

  console.log(`\n${passed} passed`);
})();
