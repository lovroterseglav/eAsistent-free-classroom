import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staticRoot = resolve(projectRoot, "dist");
const { buildApp } = await import("../api/build/src/app.js");
const { SchoolCatalog } = await import("../api/build/src/catalog.js");

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

export async function buildDevApp(options = {}) {
  const app = await buildApp(options);
  app.get("/", async (_request, reply) => sendStatic("index.html", reply));
  app.get("/*", async (request, reply) => sendStatic(request.params["*"], reply));
  return app;
}

async function sendStatic(requestedPath, reply) {
  try {
    const filePath = resolve(staticRoot, requestedPath);
    if (filePath !== staticRoot && !filePath.startsWith(`${staticRoot}${sep}`)) {
      return reply.code(403).type("text/plain").send("Forbidden");
    }
    const details = await stat(filePath);
    if (!details.isFile()) throw new Error("Not a file");
    reply.header("cache-control", "no-store");
    reply.type(contentTypes.get(extname(filePath)) ?? "application/octet-stream");
    return reply.send(createReadStream(filePath));
  } catch {
    return reply.code(404).type("text/plain").send("Not found");
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.DEV_PORT ?? "8080");
  const catalogPath = process.env.SCHOOL_CATALOG_PATH ?? resolve(projectRoot, ".data/schools.json");
  const catalog = await SchoolCatalog.open(catalogPath);
  const app = await buildDevApp({ logger: true, catalog });
  await app.listen({ host: "127.0.0.1", port });
  console.log(`Website: http://localhost:${port}`);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => app.close().finally(() => process.exit(0)));
  }
}
