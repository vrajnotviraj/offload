// Copies the face models the web app's "Sort by people" uses from @vladmandic/face-api into public/models/faces,
// so they're served by this site (nothing is fetched from anyone else). Runs before `next dev` and `next build`.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules", "@vladmandic", "face-api", "model");
const to = join(root, "public", "models", "faces");
const files = [
  "ssd_mobilenetv1_model-weights_manifest.json",
  "ssd_mobilenetv1_model.bin",
  "face_landmark_68_model-weights_manifest.json",
  "face_landmark_68_model.bin",
  "face_recognition_model-weights_manifest.json",
  "face_recognition_model.bin",
];
if (!existsSync(from)) {
  console.warn("face-models: @vladmandic/face-api isn't installed; skipping.");
  process.exit(0);
}
mkdirSync(to, { recursive: true });
for (const f of files) copyFileSync(join(from, f), join(to, f));
console.log(`face-models: copied ${files.length} files to public/models/faces`);
