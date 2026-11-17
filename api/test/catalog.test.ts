import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { INITIAL_SCHOOL, INITIAL_SCHOOLS, SchoolCatalog, timetableUrlForToken } from "../src/catalog.js";

test("persists, deduplicates, and merges the bundled school catalog", async () => {
  const directory = await mkdtemp(join(tmpdir(), "school-catalog-"));
  const file = join(directory, "schools.json");
  try {
    const catalog = await SchoolCatalog.open(file);
    assert.equal(catalog.list().length, INITIAL_SCHOOLS.length);
    assert.ok(catalog.get(INITIAL_SCHOOL.token));

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
    assert.equal(reloaded.list().length, INITIAL_SCHOOLS.length + 6);
    assert.equal(await reloaded.remove(INITIAL_SCHOOL.token), true);
    const reseeded = await SchoolCatalog.open(file);
    assert.equal(reseeded.list().length, INITIAL_SCHOOLS.length + 6);
    assert.ok(reseeded.get(INITIAL_SCHOOL.token));
    assert.ok(reseeded.get(token));
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
    assert.equal(catalog.list().length, INITIAL_SCHOOLS.length);
    assert.ok(catalog.get(INITIAL_SCHOOL.token));
    assert.ok((await readdir(directory)).some((name) => name.startsWith("schools.json.corrupt-")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundled schools have unique valid tokens, names, and public URLs", () => {
  const catalog = SchoolCatalog.memory();
  const schools = catalog.list();

  assert.equal(schools.length, INITIAL_SCHOOLS.length);
  assert.equal(new Set(schools.map(({ token }) => token)).size, schools.length);
  for (const school of schools) {
    assert.match(school.token, /^[a-f0-9]{40}$/);
    assert.ok(school.name.length > 0);
    assert.equal(school.timetableUrl, timetableUrlForToken(school.token));
  }
});
