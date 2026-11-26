/**
 * Sort by people, in the browser: finds the faces in Google Drive photos and groups the ones that look like the same person.
 *
 * It runs entirely in this browser tab, with @vladmandic/face-api (TensorFlow.js) and models served by this site
 * (public/models/faces, copied by scripts/face-models.mjs). For each face it works out a 128-number "descriptor", and faces
 * whose descriptors are close are put in one group. The descriptors and face crops live only in the tab's memory: nothing
 * is sent to Offload's server or anyone else, nothing is saved, and closing the window forgets them.
 *
 * Offload never says who anyone is: groups are "Person 1", "Person 2"… until the person names them.
 *
 * Only Google Drive photos are grouped. Google's Photos API policy doesn't allow apps to produce face clusters from the
 * Google Photos library, so photos picked in Google Photos aren't offered here.
 */

import { drive, type Account } from "@/lib/drive/api";
import { tokenFor } from "@/lib/drive/browserAuth";
import { DRIVE_SCOPE } from "@/lib/drive/api";

const MODELS = "/models/faces";
/** Longest side, in pixels, a photo is scaled to before looking for faces. Bigger finds smaller faces but is slower. */
const SCAN_PX = 1024;
/**
 * Faces whose descriptors are closer than this (Euclidean distance) to a group's average can join it. face-api's usual
 * cut-off is 0.6; this is stricter, because a person split in two is easy to fix (Merge), but two people mixed in one
 * folder isn't.
 */
export const SAME_PERSON = 0.45;
/** And no face in a group may be further than this from any other: stops a group drifting from one person to the next. */
const MAX_SPREAD = 0.48;
/** Groups are merged after the first pass when their faces are this close on average (one person's faces split in two). */
const MERGE_GROUPS = 0.4;
/** Faces smaller than this (in scanned pixels) are too blurry to compare. */
const MIN_FACE_PX = 36;
/** A file bigger than this isn't downloaded whole when its thumbnail can't be read. */
const MAX_DOWNLOAD = 30 * 1024 * 1024;

type FaceApi = typeof import("@vladmandic/face-api");
let api: Promise<FaceApi> | null = null;

/** Loads TensorFlow.js and the three models (about 12 MB, cached by the browser after the first time). */
export function loadFaceModels(): Promise<FaceApi> {
  if (!api) {
    api = (async () => {
      const faceapi = await import("@vladmandic/face-api");
      // face-api re-exports TensorFlow.js, but its typings leave these two out.
      const tf = faceapi.tf as unknown as { setBackend(b: string): Promise<boolean>; ready(): Promise<void> };
      const gpu = await tf.setBackend("webgl").catch(() => false);
      if (!gpu) await tf.setBackend("cpu");
      await tf.ready();
      await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri(MODELS),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODELS),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODELS),
      ]);
      return faceapi;
    })();
    api.catch(() => (api = null));
  }
  return api;
}

export type Photo = { id: string; name: string; mimeType: string; thumbnailLink?: string; size?: string };

export type Face = {
  /** Unique within a scan. */
  key: string;
  photoId: string;
  descriptor: Float32Array;
  /** A small JPEG of the face (data: URL), to show in the review. */
  crop: string;
  score: number;
};

export type ScanResult = { photo: Photo; faces: Face[]; error?: string };

/** Reads the details of the selected Drive files, keeping the photos (not videos or other files). */
export async function photosFor(acct: Account, ids: string[]): Promise<{ photos: Photo[]; skipped: number }> {
  const photos: Photo[] = [];
  let skipped = 0;
  const queue = [...ids];
  await Promise.all(
    Array.from({ length: Math.min(6, queue.length) }, async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        try {
          const f = await drive<Photo>(acct, "GET", `files/${id}`, { fields: "id,name,mimeType,thumbnailLink,size", supportsAllDrives: true });
          if (f.mimeType?.startsWith("image/")) photos.push(f);
          else skipped++;
        } catch {
          skipped++;
        }
      }
    })
  );
  // Keep the order they were selected in.
  const at = new Map(ids.map((id, i) => [id, i]));
  photos.sort((a, b) => at.get(a.id)! - at.get(b.id)!);
  return { photos, skipped };
}

function loadImage(src: string, cors: boolean): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (cors) img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The image couldn't be read."));
    img.src = src;
  });
}

/** A canvas with the photo, its longest side at most SCAN_PX. Uses Drive's thumbnail (JPEG, works for HEIC too), else the file itself. */
async function photoCanvas(acct: Account, p: Photo): Promise<HTMLCanvasElement> {
  let img: HTMLImageElement | null = null;
  if (p.thumbnailLink) {
    const big = p.thumbnailLink.replace(/=s\d+(-[a-z0-9-]+)?$/i, `=s${SCAN_PX}`);
    try {
      img = await loadImage(big, true);
    } catch {
      img = null;
    }
  }
  if (!img) {
    if (Number(p.size || 0) > MAX_DOWNLOAD) throw new Error("It's too big to read here, and Drive has no preview of it.");
    const token = await tokenFor(acct, DRIVE_SCOPE);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${p.id}?alt=media`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Drive didn't send it (${res.status}).`);
    const url = URL.createObjectURL(await res.blob());
    try {
      img = await loadImage(url, false);
    } catch {
      throw new Error("This browser can't open that kind of image.");
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
  const scale = Math.min(1, SCAN_PX / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.naturalWidth * scale));
  c.height = Math.max(1, Math.round(img.naturalHeight * scale));
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function crop(src: HTMLCanvasElement, box: { x: number; y: number; width: number; height: number }): string {
  const pad = Math.max(box.width, box.height) * 0.25;
  const side = Math.max(box.width, box.height) + pad * 2;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const out = document.createElement("canvas");
  out.width = out.height = 96;
  out.getContext("2d")!.drawImage(src, cx - side / 2, cy - side / 2, side, side, 0, 0, 96, 96);
  return out.toDataURL("image/jpeg", 0.82);
}

/** Finds the faces in one photo. */
export async function scanPhoto(acct: Account, p: Photo): Promise<ScanResult> {
  const faceapi = await loadFaceModels();
  let canvas: HTMLCanvasElement;
  try {
    canvas = await photoCanvas(acct, p);
  } catch (e) {
    return { photo: p, faces: [], error: e instanceof Error ? e.message : String(e) };
  }
  const found = await faceapi
    .detectAllFaces(canvas, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5, maxResults: 40 }))
    .withFaceLandmarks()
    .withFaceDescriptors();
  const faces = found
    .filter((f) => Math.min(f.detection.box.width, f.detection.box.height) >= MIN_FACE_PX)
    .map((f, i) => ({
      key: `${p.id}:${i}`,
      photoId: p.id,
      descriptor: f.descriptor,
      crop: crop(canvas, f.detection.box),
      score: f.detection.score,
    }));
  return { photo: p, faces };
}

export function distance(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

function mean(faces: Face[]): Float32Array {
  const m = new Float32Array(faces[0].descriptor.length);
  for (const f of faces) for (let i = 0; i < m.length; i++) m[i] += f.descriptor[i];
  for (let i = 0; i < m.length; i++) m[i] /= faces.length;
  return m;
}

export type Cluster = { id: string; faces: Face[] };

/** How alike two groups look: the distance between their average faces (lower is more alike). */
export function groupDistance(a: Face[], b: Face[]): number {
  return a.length && b.length ? distance(mean(a), mean(b)) : Infinity;
}

/** Groups closer than this are offered first, as "looks similar", when merging. */
export const LOOKS_SIMILAR = 0.55;

type G = { faces: Face[]; centre: Float32Array; photos: Set<string> };

/** Furthest distance from `f` to any face in `g` (complete linkage), or Infinity if it's over `limit`. */
function spread(f: Face, g: G, limit: number): number {
  let worst = 0;
  for (const x of g.faces) {
    const d = distance(f.descriptor, x.descriptor);
    if (d > limit) return Infinity;
    if (d > worst) worst = d;
  }
  return worst;
}

/**
 * Groups faces that look like the same person.
 * 1. Clearest faces first, each face joins the group whose average it's closest to, if that's under SAME_PERSON and it's
 *    within MAX_SPREAD of every face already there; otherwise it starts a new group. One person can't be in a photo twice,
 *    so a face never joins a group that already has a face from its photo.
 * 2. Groups whose faces are, on average, closer than MERGE_GROUPS (and all within MAX_SPREAD) are merged.
 * Biggest groups first.
 */
export function clusterFaces(
  faces: Face[],
  { threshold = SAME_PERSON, maxSpread = MAX_SPREAD, mergeAt = MERGE_GROUPS }: { threshold?: number; maxSpread?: number; mergeAt?: number } = {}
): Cluster[] {
  const order = [...faces].sort((a, b) => b.score - a.score);
  let groups: G[] = [];
  for (const f of order) {
    let best: G | null = null;
    let bestD = Infinity;
    for (const g of groups) {
      if (g.photos.has(f.photoId)) continue;
      const d = distance(f.descriptor, g.centre);
      if (d < threshold && d < bestD && spread(f, g, maxSpread) !== Infinity) {
        bestD = d;
        best = g;
      }
    }
    if (best) {
      best.faces.push(f);
      best.photos.add(f.photoId);
      best.centre = mean(best.faces);
    } else {
      groups.push({ faces: [f], centre: f.descriptor, photos: new Set([f.photoId]) });
    }
  }

  const avgLink = (a: G, b: G): number => {
    let sum = 0;
    for (const x of a.faces)
      for (const y of b.faces) {
        const d = distance(x.descriptor, y.descriptor);
        if (d > maxSpread) return Infinity;
        sum += d;
      }
    return sum / (a.faces.length * b.faces.length);
  };
  for (;;) {
    let pair: [number, number] | null = null;
    let bestD = Math.min(mergeAt, threshold);
    for (let i = 0; i < groups.length; i++)
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i];
        const b = groups[j];
        if (distance(a.centre, b.centre) >= bestD + 0.1) continue; // cheap skip before the full comparison
        if ([...b.photos].some((p) => a.photos.has(p))) continue;
        const d = avgLink(a, b);
        if (d < bestD) {
          bestD = d;
          pair = [i, j];
        }
      }
    if (!pair) break;
    const [i, j] = pair;
    const a = groups[i];
    const b = groups[j];
    a.faces.push(...b.faces);
    b.photos.forEach((p) => a.photos.add(p));
    a.centre = mean(a.faces);
    groups = groups.filter((_, k) => k !== j);
  }

  return groups
    .sort((a, b) => b.photos.size - a.photos.size)
    .map((g, i) => ({ id: `c${i + 1}`, faces: g.faces.sort((x, y) => y.score - x.score) }));
}
