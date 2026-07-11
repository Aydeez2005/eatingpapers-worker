import express from "express";
import { extractAudio, cleanup } from "./youtube.js";
import { uploadThumbnail, uploadAudio } from "./storage.js";
import { uploadEpisode } from "./buzzsprout.js";
import { embedChapters } from "./chapters.js";
import { processAudio } from "./audio.js";

const app = express();
app.use(express.json());

// Auth middleware
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token || token !== process.env.WORKER_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/extract", async (req, res) => {
  const { youtube_url } = req.body;
  if (!youtube_url || typeof youtube_url !== "string") {
    res.status(400).json({ error: "youtube_url is required" });
    return;
  }

  // Set up SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const sendProgress = (step: string, pct: number) => {
    res.write(`data: ${JSON.stringify({ type: "progress", step, pct })}\n\n`);
  };

  let tmpDir: string | null = null;

  try {
    // 1. Fetch metadata
    sendProgress("Fetching video metadata...", 5);
    const { meta, audioPath, thumbnailPath, tmpDir: dir } = await extractAudio(youtube_url, (step, pct) => {
      sendProgress(step, pct);
    });
    tmpDir = dir;

    // 2. Embed chapters into MP3
    if (meta.chapters.length > 0) {
      sendProgress(`Embedding ${meta.chapters.length} chapters...`, 72);
      embedChapters(audioPath, meta.chapters);
    }

    // 3. Upload thumbnail to Supabase Storage
    sendProgress("Uploading cover image...", 75);
    let coverUrl: string | null = null;
    if (thumbnailPath) {
      try {
        coverUrl = await uploadThumbnail(thumbnailPath);
      } catch (e) {
        console.error("Thumbnail upload failed, continuing without cover:", e);
      }
    }

    // 4. Upload audio to Supabase Storage
    sendProgress("Uploading audio...", 85);
    const audioUrl = await uploadAudio(audioPath);

    // Strip timestamp chapter blocks from description
    // Matches a block starting with "00:00" followed by consecutive timestamp lines
    const description = meta.description
      .replace(/\n?00:00[^\n]*(?:\n\d{1,2}:\d{2}[^\n]*)*/g, "")
      .trim();

    // 5. Send final result
    sendProgress("Done!", 100);
    res.write(`data: ${JSON.stringify({
      type: "done",
      title: meta.title,
      description,
      duration_minutes: Math.round(meta.duration_seconds / 60),
      language: meta.language,
      published_at: meta.published_at,
      cover_url: coverUrl,
      audio_url: audioUrl,
      youtube_url,
      chapters: meta.chapters,
    })}\n\n`);
    res.end();
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("Extraction failed:", message);
    res.write(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`);
    res.end();
  } finally {
    if (tmpDir) cleanup(tmpDir).catch(console.error);
  }
});

app.post("/publish", async (req, res) => {
  const { audio_url, title, description, artwork_url } = req.body;
  if (!audio_url) {
    res.status(400).json({ error: "audio_url is required" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const sendProgress = (step: string, pct: number) => {
    res.write(`data: ${JSON.stringify({ type: "progress", step, pct })}\n\n`);
  };

  try {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    sendProgress("Downloading audio from storage...", 10);
    const tmpDir = await mkdtemp(join(tmpdir(), "ep-publish-"));
    const audioPath = join(tmpDir, "episode.mp3");

    const audioRes = await fetch(audio_url);
    if (!audioRes.ok) throw new Error(`Failed to download audio: ${audioRes.status}`);
    const buffer = Buffer.from(await audioRes.arrayBuffer());
    await writeFile(audioPath, buffer);

    sendProgress("Uploading to Buzzsprout...", 40);
    const episode = await uploadEpisode(
      audioPath,
      title || "Untitled",
      description || "",
      artwork_url || null
    );

    sendProgress("Done!", 100);
    res.write(`data: ${JSON.stringify({ type: "done", id: episode.id, title: episode.title })}\n\n`);
    res.end();

    const { rm } = await import("node:fs/promises");
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("Publish failed:", message);
    res.write(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`);
    res.end();
  }
});

// Process the uploaded final audio with Auphonic (all-in-one: clean +
// transcribe + chapters + subtitles + summary, configured in the saved preset).
// Input: { raw_audio_url, title }. Streams SSE progress and a final payload:
// { processed_audio_url, transcript, chapters, subtitles, summary }.
app.post("/process-audio", async (req, res) => {
  const { raw_audio_url, title } = req.body;
  if (!raw_audio_url || typeof raw_audio_url !== "string") {
    res.status(400).json({ error: "raw_audio_url is required" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const sendProgress = (step: string, pct: number) => {
    res.write(`data: ${JSON.stringify({ type: "progress", step, pct })}\n\n`);
  };

  let rawTmpDir: string | null = null;
  let cleanedPath: string | null = null;

  try {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    // 1. Download the uploaded raw audio to a temp file.
    sendProgress("Downloading uploaded audio…", 8);
    rawTmpDir = await mkdtemp(join(tmpdir(), "ep-raw-"));
    const rawPath = join(rawTmpDir, "raw.mp3");
    const dl = await fetch(raw_audio_url);
    if (!dl.ok) throw new Error(`Failed to download raw audio: ${dl.status}`);
    await writeFile(rawPath, Buffer.from(await dl.arrayBuffer()));

    // 2. Auphonic all-in-one processing → cleaned mp3 + transcript + chapters +
    //    subtitles + summary.
    const out = await processAudio(
      rawPath,
      title || "Eatingpapers episode",
      sendProgress
    );
    cleanedPath = out.mp3Path;

    // 3. Upload the cleaned audio to the public `audio` bucket.
    sendProgress("Saving cleaned audio…", 85);
    const processedAudioUrl = await uploadAudio(cleanedPath);

    sendProgress("Done!", 100);
    res.write(
      `data: ${JSON.stringify({
        type: "done",
        processed_audio_url: processedAudioUrl,
        transcript: out.transcript,
        chapters: out.chapters,
        subtitles: out.subtitles,
        summary: out.summary,
      })}\n\n`
    );
    res.end();
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("process-audio failed:", message);
    res.write(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`);
    res.end();
  } finally {
    const { rm } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    if (rawTmpDir) {
      await rm(rawTmpDir, { recursive: true, force: true }).catch(() => {});
    }
    if (cleanedPath) {
      await rm(dirname(cleanedPath), { recursive: true, force: true }).catch(() => {});
    }
  }
});

const port = parseInt(process.env.PORT || "3333");
app.listen(port, () => console.log(`Worker listening on :${port}`));
