import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export async function uploadAudio(filePath: string): Promise<string> {
  const supabase = getSupabase();
  const { readFile } = await import("node:fs/promises");
  const buffer = await readFile(filePath);
  const fileName = `ep-${Date.now()}.mp3`;

  const { error } = await supabase.storage
    .from("audio")
    .upload(fileName, buffer, { contentType: "audio/mpeg" });

  if (error) throw new Error(`Audio upload failed: ${error.message}`);

  const { data } = supabase.storage.from("audio").getPublicUrl(fileName);
  return data.publicUrl;
}

export async function uploadThumbnail(filePath: string): Promise<string> {
  const supabase = getSupabase();
  const { readFile } = await import("node:fs/promises");
  const buffer = await readFile(filePath);
  const ext = filePath.endsWith(".png") ? "png" : "jpg";
  const contentType = ext === "png" ? "image/png" : "image/jpeg";
  const fileName = `yt-${Date.now()}.${ext}`;

  const { error } = await supabase.storage
    .from("covers")
    .upload(fileName, buffer, { contentType });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data } = supabase.storage.from("covers").getPublicUrl(fileName);
  return data.publicUrl;
}
