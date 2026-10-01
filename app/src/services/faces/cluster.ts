import { cosine } from './geometry';

// ── Grouping faces into people ────────────────────────────────────────────────
// The first version of this matched each new face against a running CENTROID per
// person and, failing that, started a new person. That is why one person came
// out as several: a centroid is the average of the faces seen so far, so a
// profile shot sits far from it even when it is nearly identical to another
// profile shot of the same person. Worse, the pass was greedy and one-way — once
// a person had split in two nothing could ever rejoin them, and the result
// depended on the order the videos happened to be scanned in.
//
// This replaces it with density clustering (DBSCAN) over EVERY stored face, the
// approach Immich uses: a face is compared against individual faces rather than
// an average, so a chain of similar shots holds a person together across pose
// and lighting. Two knobs, both exposed in the UI:
//   • threshold — how alike two faces must be to count as neighbours
//   • minFaces  — how many neighbours a face needs before it can anchor a group,
//                 which is what stops one blurry frame bridging two people
// Because it reads the stored embeddings it can be re-run at any time, so
// changing a setting re-groups in seconds instead of demanding a fresh scan.

export interface FaceVector {
  id: string;
  embedding: Float32Array;
}

export interface ClusterOptions {
  /** Cosine similarity needed for two faces to be neighbours. */
  threshold: number;
  /** Faces in a neighbourhood (counting itself) needed to anchor a group. */
  minFaces: number;
}

export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = {
  // Measured on degraded frames with the large recogniser: the same person
  // stayed above 0.597 and different people never passed 0.129. 0.35 sits in
  // that gap with room for the harder poses real video contains.
  threshold: Number(process.env.SV_FACE_THRESHOLD) || 0.35,
  minFaces: Number(process.env.SV_FACE_MIN_FACES) || 2,
};

/** Faces this far apart are never compared again once grouped — see clusterFaces. */
export interface ClusterResult {
  /** Face id → group index. Faces too isolated to group are absent. */
  groups: Map<string, number>;
  count: number;
}

/**
 * Density-cluster faces into people.
 *
 * `links` are must-link pairs of face ids: whatever the geometry says, those
 * faces end up in the same group. Manual merges are recorded that way, so a
 * correction a person made by hand survives every later re-grouping.
 *
 * Cost is O(n²) in the number of faces. That is deliberate — it is an explicit,
 * backgrounded action, and an exact pass over a few thousand faces takes seconds
 * where an approximate index would add a dependency and a whole class of bugs.
 */
export function clusterFaces(
  faces: FaceVector[],
  options: ClusterOptions = DEFAULT_CLUSTER_OPTIONS,
  links: Array<[string, string]> = [],
  onProgress?: (done: number, total: number) => void,
): ClusterResult {
  const n = faces.length;
  const groups = new Map<string, number>();
  if (n === 0) return { groups, count: 0 };

  const threshold = Math.max(-1, Math.min(1, options.threshold));
  const minFaces = Math.max(1, Math.floor(options.minFaces));

  // 1. Neighbourhoods. Symmetric, so only half the matrix is computed.
  const neighbours: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    const a = faces[i]!.embedding;
    for (let j = i + 1; j < n; j++) {
      if (cosine(a, faces[j]!.embedding) >= threshold) {
        neighbours[i]!.push(j);
        neighbours[j]!.push(i);
      }
    }
    if (onProgress && (i & 63) === 0) onProgress(i, n);
  }

  // 2. A face anchors a group only when its neighbourhood is dense enough. A
  //    one-off blurry face has few neighbours, so it cannot bridge two people.
  const isCore = neighbours.map(list => list.length + 1 >= minFaces);

  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[i] !== root) { const next = parent[i]!; parent[i] = root; i = next; }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // 3. Join neighbouring anchors; a chain of them is one person seen many ways.
  for (let i = 0; i < n; i++) {
    if (!isCore[i]) continue;
    for (const j of neighbours[i]!) if (isCore[j]) union(i, j);
  }

  // 4. Attach every remaining face to its most similar anchor, so an odd angle
  //    still lands on the right person instead of inventing a new one.
  const index = new Map(faces.map((f, i) => [f.id, i]));
  for (let i = 0; i < n; i++) {
    if (isCore[i]) continue;
    let best = -1;
    let bestScore = -Infinity;
    for (const j of neighbours[i]!) {
      if (!isCore[j]) continue;
      const score = cosine(faces[i]!.embedding, faces[j]!.embedding);
      if (score > bestScore) { bestScore = score; best = j; }
    }
    if (best >= 0) union(i, best);
  }

  // 5. Manual corrections win over the geometry.
  for (const [a, b] of links) {
    const ia = index.get(a);
    const ib = index.get(b);
    if (ia !== undefined && ib !== undefined) union(ia, ib);
  }

  // 6. Number the groups. A face that never joined an anchor and was linked to
  //    nothing stays out: a single unexplained face is not a person.
  const linked = new Set<number>();
  for (const [a, b] of links) {
    const ia = index.get(a); const ib = index.get(b);
    if (ia !== undefined && ib !== undefined) { linked.add(ia); linked.add(ib); }
  }
  const groupIds = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const alone = !isCore[i] && root === i && !linked.has(i);
    if (alone) continue;
    let id = groupIds.get(root);
    if (id === undefined) { id = groupIds.size; groupIds.set(root, id); }
    groups.set(faces[i]!.id, id);
  }
  onProgress?.(n, n);
  return { groups, count: groupIds.size };
}
