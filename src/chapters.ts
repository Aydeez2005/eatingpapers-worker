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
