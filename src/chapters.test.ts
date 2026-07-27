import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import NodeID3 from "node-id3";
import { embedChapters, toEmbeddableChapters } from "./chapters.js";

describe("embedChapters", () => {
  it("replaces pre-existing chapters instead of stacking duplicates", () => {
    const dir = mkdtempSync(join(tmpdir(), "chap-test-"));
    const file = join(dir, "episode.mp3");
    try {
      // Minimal MPEG audio frame so node-id3 has a real file to tag.
      writeFileSync(file, Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00]));

      // Simulate chapters already embedded upstream (e.g. by Auphonic).
      NodeID3.write(
        {
          chapter: [
            { elementID: "old0", startTimeMs: 0, endTimeMs: 60000, tags: { title: "Old Intro" } },
            { elementID: "old1", startTimeMs: 60000, endTimeMs: 120000, tags: { title: "Old Middle" } },
          ],
        },
        file
      );

      embedChapters(file, [
        { title: "New Intro", start_time: 0, end_time: 90 },
      ]);

      const tags = NodeID3.read(file);
      const chapters = Array.isArray(tags.chapter) ? tags.chapter : tags.chapter ? [tags.chapter] : [];
      expect(chapters).toHaveLength(1);
      expect(chapters[0].tags?.title).toBe("New Intro");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("toEmbeddableChapters", () => {
  it("derives end_time from the next chapter's start, last from duration", () => {
    const out = toEmbeddableChapters(
      [
        { title: "Intro", start_seconds: 0 },
        { title: "Middle", start_seconds: 60.5 },
        { title: "End", start_seconds: 120 },
      ],
      180
    );
    expect(out).toEqual([
      { title: "Intro", start_time: 0, end_time: 60.5 },
      { title: "Middle", start_time: 60.5, end_time: 120 },
      { title: "End", start_time: 120, end_time: 180 },
    ]);
  });

  it("sorts by start and drops non-finite starts", () => {
    const out = toEmbeddableChapters(
      [
        { title: "B", start_seconds: 30 },
        { title: "A", start_seconds: 0 },
        { title: "Bad", start_seconds: NaN },
      ],
      60
    );
    expect(out.map((c) => c.title)).toEqual(["A", "B"]);
    expect(out[1].end_time).toBe(60);
  });

  it("returns [] for empty input", () => {
    expect(toEmbeddableChapters([], 100)).toEqual([]);
  });
});
