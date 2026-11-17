import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { INITIAL_SCHOOL, SchoolCatalog, timetableUrlForToken } from "../src/catalog.js";

test("persists, deduplicates, and removes schools without reseeding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "school-catalog-"));
  const file = join(directory, "schools.json");
  try {
    const catalog = await SchoolCatalog.open(file);
    assert.deepEqual(catalog.list().map(({ token }) => token), [INITIAL_SCHOOL.token]);

    const token = "a".repeat(40);
    assert.equal(await catalog.add(token, "  Druga   šola  "), true);
    assert.equal(await catalog.add(token, "Spremenjeno ime"), false);
    assert.equal(catalog.get(token)?.name, "Druga šola");
    assert.equal(catalog.get(token)?.timetableUrl, timetableUrlForToken(token));

    await Promise.all(Array.from({ length: 5 }, (_value, index) => {
      const concurrentToken = (index + 1).toString(16).padStart(40, "0");
      return catalog.add(concurrentToken, `Sočasna šola ${index + 1}`);
    }));

    const reloaded = await SchoolCatalog.open(file);
    assert.equal(reloaded.list().length, 7);
    assert.equal(await reloaded.remove(INITIAL_SCHOOL.token), true);
    const withoutSeed = await SchoolCatalog.open(file);
    assert.equal(withoutSeed.list().length, 6);
    assert.ok(withoutSeed.get(token));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves a corrupt catalog and starts a valid replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "school-catalog-corrupt-"));
  const file = join(directory, "schools.json");
  try {
    await writeFile(file, "{broken", "utf8");
    const catalog = await SchoolCatalog.open(file);
    assert.equal(catalog.list()[0]?.token, INITIAL_SCHOOL.token);
    assert.ok((await readdir(directory)).some((name) => name.startsWith("schools.json.corrupt-")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
