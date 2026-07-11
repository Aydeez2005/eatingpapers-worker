import NodeID3 from "node-id3";
import type { Chapter } from "./youtube.js";

export function embedChapters(audioPath: string, chapters: Chapter[]): boolean {
  if (chapters.length === 0) return false;

  const id3Chapters = chapters.map((ch, i) => ({
    elementID: `ch${i}`,
    startTimeMs: Math.round(ch.start_time * 1000),
    endTimeMs: Math.round(ch.end_time * 1000),
    tags: {
      title: ch.title,
    },
  }));

  const result = NodeID3.update({ chapter: id3Chapters }, audioPath);
  return result === true;
}

export interface TimedChapter {
  title: string;
  start_seconds: number;
}

// Auphonic chapters carry only a start. NodeID3 needs start+end, so derive each
// end from the next chapter's start and the last from the audio duration.
export function toEmbeddableChapters(
  chapters: TimedChapter[],
  durationSeconds: number
): Chapter[] {
  const sorted = chapters
    .filter((c) => Number.isFinite(c.start_seconds))
    .sort((a, b) => a.start_seconds - b.start_seconds);
  return sorted.map((c, i) => ({
    title: c.title,
    start_time: c.start_seconds,
    end_time: i < sorted.length - 1 ? sorted[i + 1].start_seconds : durationSeconds,
  }));
}

// Read an audio file's duration (seconds) via ffprobe (installed in the image).
export async function getAudioDurationSeconds(path: string): Promise<number> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    path,
  ]);
  const seconds = parseFloat(stdout.trim());
  if (!Number.isFinite(seconds)) {
    throw new Error("Could not read audio duration via ffprobe");
  }
  return seconds;
}

export function formatChaptersForDescription(chapters: Chapter[]): string {
  if (chapters.length === 0) return "";

  return chapters
    .map((ch) => {
      const totalSecs = Math.round(ch.start_time);
      const hrs = Math.floor(totalSecs / 3600);
      const mins = Math.floor((totalSecs % 3600) / 60);
      const secs = totalSecs % 60;
      const timestamp = hrs > 0
        ? `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
        : `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
      return `${timestamp} ${ch.title}`;
    })
    .join("\n");
}
