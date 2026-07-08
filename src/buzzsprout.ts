import { readFile } from "node:fs/promises";
import { basename } from "node:path";

interface BuzzsproutEpisode {
  id: number;
  title: string;
}

export async function uploadEpisode(
  audioPath: string,
  title: string,
  description: string,
  artworkUrl?: string | null
): Promise<BuzzsproutEpisode> {
  const podcastId = process.env.BUZZSPROUT_PODCAST_ID!;
  const apiToken = process.env.BUZZSPROUT_API_TOKEN!;

  const audioBuffer = await readFile(audioPath);
  const blob = new Blob([audioBuffer], { type: "audio/mpeg" });

  const form = new FormData();
  form.append("audio_file", blob, basename(audioPath));
  form.append("title", title);
  form.append("description", description);
  // Episode artwork (podcast cover, must be square). Buzzsprout accepts a URL
  // directly, so we hand over the hosted Supabase image instead of the bytes.
  // No published_at is sent, so the episode lands as an unpublished draft.
  if (artworkUrl) form.append("artwork_url", artworkUrl);
  const response = await fetch(
    `https://www.buzzsprout.com/api/${podcastId}/episodes.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Token token=${apiToken}`,
      },
      body: form,
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Buzzsprout upload failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  return { id: data.id, title: data.title };
}
