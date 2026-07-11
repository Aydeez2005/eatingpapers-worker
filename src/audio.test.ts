import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hhmmssToSeconds,
  waitForAuphonicProduction,
  fetchOutputs,
  stripHtml,
} from "./audio.js";

afterEach(() => vi.restoreAllMocks());

describe("hhmmssToSeconds", () => {
  it("parses HH:MM:SS", () => {
    expect(hhmmssToSeconds("01:02:03")).toBe(3723);
  });

  it("parses HH:MM:SS.mmm", () => {
    expect(hhmmssToSeconds("00:00:01.500")).toBeCloseTo(1.5, 3);
  });

  it("tolerates MM:SS", () => {
    expect(hhmmssToSeconds("02:05")).toBe(125);
  });

  it("handles zero", () => {
    expect(hhmmssToSeconds("00:00:00")).toBe(0);
  });
});

describe("waitForAuphonicProduction", () => {
  it("polls until Done and returns the whole data object", async () => {
    const responses = [
      { data: { status: 5, status_string: "Audio Processing" } },
      { data: { status: 5, status_string: "Audio Processing" } },
      {
        data: {
          status: 3,
          status_string: "Done",
          output_files: [
            { download_url: "https://auphonic.com/dl/result.mp3", ending: "mp3" },
          ],
        },
      },
    ];
    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const body = responses[Math.min(call, responses.length - 1)];
      call++;
      return new Response(JSON.stringify(body), { status: 200 });
    });
    process.env.AUPHONIC_API_KEY = "au-test";

    const steps: string[] = [];
    const data = await waitForAuphonicProduction(
      "uuid-1",
      (s) => steps.push(s),
      { pollIntervalMs: 0, maxWaitMs: 10_000 }
    );

    expect(data.output_files).toBeDefined();
    expect(data.output_files[0].download_url).toBe(
      "https://auphonic.com/dl/result.mp3"
    );
    expect(call).toBe(3);
    expect(steps.length).toBeGreaterThan(0);
  });

  it("throws when Auphonic reports an error status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ data: { status: 2, status_string: "Error" } }),
        { status: 200 }
      )
    );
    process.env.AUPHONIC_API_KEY = "au-test";
    await expect(
      waitForAuphonicProduction("uuid-1", () => {}, { pollIntervalMs: 0 })
    ).rejects.toThrow(/Auphonic/);
  });
});

describe("fetchOutputs", () => {
  const DATA = {
    output_files: [
      {
        download_url: "https://auphonic.com/dl/clean.mp3",
        filename: "clean.mp3",
        ending: "mp3",
        format: "mp3",
      },
      {
        download_url: "https://auphonic.com/dl/subs.srt",
        filename: "subs.srt",
        ending: "srt",
        format: "srt",
      },
      {
        download_url: "https://auphonic.com/dl/transcript.txt",
        filename: "transcript.txt",
        ending: "txt",
        format: "txt",
      },
    ],
    chapters: [
      { start: "00:00:00", title: "Intro" },
      { start: "00:01:30.500", title: "Main topic" },
    ],
    metadata: { summary: "A great episode." },
  };

  it("downloads the mp3, fetches srt/txt, converts chapters, extracts summary", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(async (input: any) => {
        const url = String(input);
        if (url.endsWith(".mp3")) {
          return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
        }
        if (url.endsWith(".srt")) {
          return new Response("1\n00:00:00,000 --> 00:00:02,000\nHello", {
            status: 200,
          });
        }
        if (url.endsWith(".txt")) {
          return new Response("Hello world transcript", { status: 200 });
        }
        return new Response("nope", { status: 404 });
      });
    process.env.AUPHONIC_API_KEY = "au-test";

    const out = await fetchOutputs(DATA);

    // Fetched the three output URLs.
    const fetchedUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(fetchedUrls).toContain("https://auphonic.com/dl/clean.mp3");
    expect(fetchedUrls).toContain("https://auphonic.com/dl/subs.srt");
    expect(fetchedUrls).toContain("https://auphonic.com/dl/transcript.txt");

    // Bearer auth was sent.
    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer au-test"
    );

    expect(out.transcript).toBe("Hello world transcript");
    expect(out.subtitles).toContain("Hello");
    expect(out.summary).toBe("A great episode.");
    expect(out.chapters).toEqual([
      { start_seconds: 0, title: "Intro" },
      { start_seconds: 90.5, title: "Main topic" },
    ]);

    // mp3Path points at a real temp file with the downloaded bytes.
    const { readFile, rm } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const buf = await readFile(out.mp3Path);
    expect(buf.length).toBe(3);
    await rm(dirname(out.mp3Path), { recursive: true, force: true });
  });

  it("throws naming the missing output when the mp3 is absent", async () => {
    const noMp3 = {
      ...DATA,
      output_files: DATA.output_files.filter((f) => f.ending !== "mp3"),
    };
    process.env.AUPHONIC_API_KEY = "au-test";
    await expect(fetchOutputs(noMp3)).rejects.toThrow(/mp3/i);
  });

  it("throws naming the missing output when the srt is absent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1]), { status: 200 })
    );
    const noSrt = {
      ...DATA,
      output_files: DATA.output_files.filter((f) => f.ending !== "srt"),
    };
    process.env.AUPHONIC_API_KEY = "au-test";
    await expect(fetchOutputs(noSrt)).rejects.toThrow(/srt/i);
  });
});

describe("stripHtml", () => {
  it("strips tags/entities from Auphonic's HTML transcript to plain text", () => {
    const html =
      "<html><body><p>Hello &amp; welcome.</p><p>Second line here.</p></body></html>";
    expect(stripHtml(html)).toBe("Hello & welcome.\nSecond line here.");
  });

  it("leaves already-plain text essentially intact", () => {
    expect(stripHtml("Just plain text.")).toBe("Just plain text.");
  });
});
