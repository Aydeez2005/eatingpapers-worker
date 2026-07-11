import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdir } from "node:fs/promises";

const exec = promisify(execFile);

export type ProgressCallback = (step: string, pct: number) => void;

export interface Chapter {
  title: string;
  start_time: number; // seconds
  end_time: number;   // seconds
}

export interface VideoMeta {
  title: string;
  description: string;
  duration_seconds: number;
  thumbnail_url: string;
  language: string | null;
  published_at: string | null;
  chapters: Chapter[];
}

export interface ExtractionResult {
  meta: VideoMeta;
  audioPath: string;
  thumbnailPath: string | null;
  tmpDir: string;
}

// yt-dlp opens the --cookies file read-write (it saves refreshed cookies on
// close). On Render, secret files are mounted read-only (/etc/secrets/...), so
// pointing yt-dlp straight at them crashes with EROFS. Copy the cookies to a
// writable temp file once and hand yt-dlp that instead.
let cookiesArgsPromise: Promise<string[]> | null = null;
function cookiesArgs(): Promise<string[]> {
  if (!cookiesArgsPromise) {
    cookiesArgsPromise = (async () => {
      const file = process.env.YT_COOKIES_FILE;
      if (!file) return [];
      const dest = join(tmpdir(), "yt-cookies.txt");
      try {
        await copyFile(file, dest);
        return ["--cookies", dest];
      } catch {
        // Fall back to the original path (best effort).
        return ["--cookies", file];
      }
    })();
  }
  return cookiesArgsPromise;
}

function cleanYouTubeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Keep only the v parameter, strip t, list, index, etc.
    const videoId = u.searchParams.get("v");
    if (videoId && u.hostname.includes("youtube.com")) {
      return `https://www.youtube.com/watch?v=${videoId}`;
    }
    return url;
  } catch {
    return url;
  }
}

export async function getVideoMeta(url: string): Promise<VideoMeta> {
  const { stdout } = await exec("yt-dlp", ["--dump-json", "--no-download", "--extractor-args", "youtube:player_client=web,default", ...(await cookiesArgs()), url], {
    maxBuffer: 10 * 1024 * 1024,
  });
  const info = JSON.parse(stdout);
  return {
    title: info.title ?? "",
    description: info.description ?? "",
    duration_seconds: info.duration ?? 0,
    thumbnail_url: info.thumbnail ?? "",
    language: info.language?.split("-")[0] ?? null,
    published_at: info.upload_date
      ? `${info.upload_date.slice(0, 4)}-${info.upload_date.slice(4, 6)}-${info.upload_date.slice(6, 8)}`
      : null,
    chapters: (info.chapters ?? []).map((ch: { title: string; start_time: number; end_time: number }) => ({
      title: ch.title ?? "",
      start_time: ch.start_time ?? 0,
      end_time: ch.end_time ?? 0,
    })),
  };
}

export async function extractAudio(
  url: string,
  onProgress?: ProgressCallback
): Promise<ExtractionResult> {
  const cleanUrl = cleanYouTubeUrl(url);
  onProgress?.("Fetching video metadata...", 5);
  const meta = await getVideoMeta(cleanUrl);
  onProgress?.("Metadata fetched, downloading audio...", 10);

  const tmpDir = await mkdtemp(join(tmpdir(), "ep-worker-"));
  const outputTemplate = join(tmpDir, "audio.%(ext)s");
  const cookies = await cookiesArgs();

  // Use spawn instead of exec to read yt-dlp progress output
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("yt-dlp", [
      "-x", "--audio-format", "mp3",
      "--extractor-args", "youtube:player_client=web,default",
      "--postprocessor-args", "ffmpeg:-b:a 128k",
      "--write-thumbnail", "--convert-thumbnails", "jpg",
      "--newline", "--progress",
      ...cookies,
      "-o", outputTemplate, cleanUrl,
    ]);

    let stderr = "";

    proc.stderr.on("data", (chunk: Buffer) => {
      const line = chunk.toString();
      stderr += line;

      // Parse yt-dlp download progress lines like "[download]  45.2% of ..."
      const match = line.match(/\[download\]\s+([\d.]+)%/);
      if (match) {
        const dlPct = parseFloat(match[1]);
        // Map download 0-100% to our 10-60% range
        const pct = 10 + (dlPct / 100) * 50;
        onProgress?.(`Downloading audio... ${Math.round(dlPct)}%`, Math.round(pct));
      }

      // Detect conversion phase
      if (line.includes("[ExtractAudio]") || line.includes("Converting")) {
        onProgress?.("Converting to MP3...", 65);
      }
    });

    proc.stdout.on("data", (chunk: Buffer) => {
      const line = chunk.toString();
      const match = line.match(/\[download\]\s+([\d.]+)%/);
      if (match) {
        const dlPct = parseFloat(match[1]);
        const pct = 10 + (dlPct / 100) * 50;
        onProgress?.(`Downloading audio... ${Math.round(dlPct)}%`, Math.round(pct));
      }
      if (line.includes("[ExtractAudio]") || line.includes("Converting")) {
        onProgress?.("Converting to MP3...", 65);
      }
    });

    proc.on("close", (code) => {
      if (code === 0) {
        onProgress?.("Audio extraction complete", 70);
        resolve();
      } else {
        reject(new Error(`yt-dlp exited with code ${code}: ${stderr}`));
      }
    });

    proc.on("error", reject);

    setTimeout(() => {
      proc.kill();
      reject(new Error("yt-dlp timed out after 5 minutes"));
    }, 300_000);
  });

  const files = await readdir(tmpDir);
  const mp3File = files.find((f) => f.endsWith(".mp3"));
  if (!mp3File) throw new Error("Audio extraction failed: no MP3 file produced");

  const thumbFile = files.find((f) => /\.(jpg|jpeg|png|webp)$/i.test(f));

  return {
    meta,
    audioPath: join(tmpDir, mp3File),
    thumbnailPath: thumbFile ? join(tmpDir, thumbFile) : null,
    tmpDir,
  };
}

export async function cleanup(tmpDir: string): Promise<void> {
  await rm(tmpDir, { recursive: true, force: true });
}
