const AUPHONIC_API = "https://auphonic.com/api";

function auphonicKey(): string {
  const key = process.env.AUPHONIC_API_KEY;
  if (!key) throw new Error("AUPHONIC_API_KEY is not set");
  return key;
}

// Auphonic status codes: 3 = Done. Error-ish terminal states we bail on.
const AUPHONIC_ERROR_STATES = new Set([2, 9, 13]); // Error, Incomplete, Fail

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface AuphonicChapter {
  start_seconds: number;
  title: string;
}

export interface AuphonicOutputs {
  mp3Path: string;
  transcript: string;
  subtitles: string;
  chapters: AuphonicChapter[];
  summary: string;
}

export interface AuphonicWaitOpts {
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

// Parse an Auphonic timestamp ("HH:MM:SS", "HH:MM:SS.mmm", or "MM:SS") to
// seconds. Pure.
export function hhmmssToSeconds(ts: string): number {
  const parts = String(ts).trim().split(":");
  // Positional base-60: rightmost part carries any fractional seconds.
  let seconds = 0;
  for (const part of parts) {
    seconds = seconds * 60 + parseFloat(part);
  }
  return seconds;
}

// Poll an Auphonic production until it finishes; return the whole `data` object
// (output_files + chapters + metadata). Reports coarse progress via onProgress.
export async function waitForAuphonicProduction(
  uuid: string,
  onProgress: (step: string, pct: number) => void,
  opts: AuphonicWaitOpts = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const pollIntervalMs = opts.pollIntervalMs ?? 5000;
  const maxWaitMs = opts.maxWaitMs ?? 20 * 60 * 1000; // 20 min cap
  const started = Date.now();

  // Date.now-based loop; safe on the worker (not the resumable workflow env).
  for (;;) {
    const res = await fetch(`${AUPHONIC_API}/production/${uuid}.json`, {
      headers: { Authorization: `Bearer ${auphonicKey()}` },
    });
    if (!res.ok) {
      throw new Error(`Auphonic status failed: ${res.status}`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json();
    const status: number = json?.data?.status;
    const statusString: string = json?.data?.status_string ?? "Processing";

    if (status === 3) {
      onProgress("Cleanup done", 70);
      return json.data;
    }
    if (AUPHONIC_ERROR_STATES.has(status)) {
      throw new Error(`Auphonic error: ${statusString}`);
    }

    onProgress(`Cleaning audio… (${statusString})`, 45);
    if (Date.now() - started > maxWaitMs) {
      throw new Error("Auphonic timed out");
    }
    await sleep(pollIntervalMs);
  }
}

// Upload a local audio file to Auphonic (Simple API) using the saved preset and
// start processing immediately. Returns the production UUID.
async function startAuphonicProduction(
  inputFilePath: string,
  title: string
): Promise<string> {
  const presetUuid = process.env.AUPHONIC_PRESET_UUID;
  if (!presetUuid) throw new Error("AUPHONIC_PRESET_UUID is not set");

  const { readFile } = await import("node:fs/promises");
  const { basename } = await import("node:path");
  const buffer = await readFile(inputFilePath);

  const form = new FormData();
  form.append("preset", presetUuid);
  form.append("title", title);
  form.append("action", "start");
  form.append(
    "input_file",
    new Blob([buffer], { type: "audio/mpeg" }),
    basename(inputFilePath)
  );

  const res = await fetch(`${AUPHONIC_API}/simple/productions.json`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auphonicKey()}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Auphonic create failed: ${res.status} ${await res.text()}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await res.json();
  const uuid = json?.data?.uuid;
  if (!uuid) throw new Error("Auphonic did not return a production uuid");
  return uuid as string;
}

// Find an output file's download URL by extension, preferring the `ending`
// field and falling back to the filename extension. Returns null if absent.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findOutputUrl(data: any, ext: string): string | null {
  const files = data?.output_files ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const match = files.find((f: any) => {
    const ending = String(f?.ending ?? "").toLowerCase();
    if (ending === ext) return true;
    const name = String(f?.filename ?? "").toLowerCase();
    return name.endsWith(`.${ext}`);
  });
  return match?.download_url ?? null;
}

// Download a URL (Bearer auth) to a temp file; return its path.
async function downloadToTempFile(url: string): Promise<string> {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${auphonicKey()}` },
  });
  if (!res.ok) throw new Error(`Auphonic download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  const dir = await mkdtemp(join(tmpdir(), "ep-clean-"));
  const outPath = join(dir, "cleaned.mp3");
  await writeFile(outPath, buffer);
  return outPath;
}

// Fetch a URL's text body (Bearer auth) — used for the srt + transcript outputs.
async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${auphonicKey()}` },
  });
  if (!res.ok) throw new Error(`Auphonic download failed: ${res.status}`);
  return res.text();
}

// Auphonic's transcript output is HTML (it offers no plaintext format), so
// strip tags/entities to plain text. A no-op on already-plain text.
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// From a finished production's `data`: download the cleaned mp3, fetch the srt
// (subtitles) + txt (transcript), convert chapters to seconds, and pull the
// summary. Throws (naming the format) if a required output is missing so a
// misconfigured preset is obvious.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchOutputs(data: any): Promise<AuphonicOutputs> {
  const mp3Url = findOutputUrl(data, "mp3");
  if (!mp3Url) throw new Error("Auphonic output missing: mp3");
  const srtUrl = findOutputUrl(data, "srt");
  if (!srtUrl) throw new Error("Auphonic output missing: srt");
  // Auphonic's transcript output is HTML (no plaintext option); accept .txt or
  // .html and strip tags to plain text.
  const transcriptUrl =
    findOutputUrl(data, "txt") ?? findOutputUrl(data, "html");
  if (!transcriptUrl)
    throw new Error("Auphonic output missing: transcript (txt/html)");

  const mp3Path = await downloadToTempFile(mp3Url);
  const subtitles = await fetchText(srtUrl);
  const transcript = stripHtml(await fetchText(transcriptUrl));

  const chapters: AuphonicChapter[] = (data?.chapters ?? []).map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c: any) => ({
      start_seconds: hhmmssToSeconds(c.start),
      title: c.title,
    })
  );

  const summary: string = data?.metadata?.summary ?? "";

  return { mp3Path, transcript, subtitles, chapters, summary };
}

// Full pipeline: upload → start → wait → fetch all outputs. Auphonic does the
// clean + transcribe (Whisper) + chapters + subtitles + summary in one
// production (configured in the saved preset).
export async function processAudio(
  inputFilePath: string,
  title: string,
  onProgress: (step: string, pct: number) => void
): Promise<AuphonicOutputs> {
  onProgress("Uploading to Auphonic…", 20);
  const uuid = await startAuphonicProduction(inputFilePath, title);
  onProgress("Cleaning + transcribing…", 40);
  const data = await waitForAuphonicProduction(uuid, onProgress);
  onProgress("Fetching results…", 75);
  return fetchOutputs(data);
}
