import { describe, it, expect } from "vitest";
import { toEmbeddableChapters } from "./chapters.js";

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
