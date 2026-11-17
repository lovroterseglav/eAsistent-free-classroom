import { readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const required = ["dist/index.html", "dist/app.mjs", "dist/school-state.mjs", "dist/styles.css", ".openai/hosting.json"];
for (const path of required) {
  if (!statSync(resolve(root, path)).isFile()) throw new Error(`Manjka ${path}`);
}

const manifest = JSON.parse(readFileSync(resolve(root, ".openai/hosting.json"), "utf8"));
if (manifest.static?.directory !== "dist" || !manifest.project_id) throw new Error("Neveljaven hosting manifest.");

for (const file of ["dist/app.mjs", "dist/school-state.mjs", "scripts/dev-server.mjs"]) {
  const check = spawnSync(process.execPath, ["--check", resolve(root, file)], { encoding: "utf8" });
  if (check.status !== 0) throw new Error(check.stderr || `Preverjanje ${file} ni uspelo.`);
}

const forbidden = ["ajax", "urnik"].join("_");
const files = [];
function walk(directory) {
  for (const name of readdirSync(directory)) {
    if ([".git", "node_modules"].includes(name)) continue;
    const path = resolve(directory, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
}
walk(root);
for (const file of files) {
  if (readFileSync(file).includes(forbidden)) throw new Error(`Prepovedana zapuščinska pot v ${file}`);
}

console.log(`Static checks passed (${files.length} files).`);
