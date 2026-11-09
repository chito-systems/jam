// Browser recordings (MediaRecorder webm/mp4) are sometimes rejected by the transcription API
// as undecodable. ffmpeg is far more tolerant, so on a rejection we re-encode to a small mono
// mp3 and try once more.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface AudioBlob {
  data: Uint8Array;
  mime: string;
  filename?: string;
}

export type Transcode = (audio: AudioBlob) => Promise<AudioBlob>;

/** Re-encodes any audio/video ffmpeg can read to 16 kHz mono mp3. Throws with ffmpeg's reason if it can't. */
export const transcodeToMp3: Transcode = async (audio) => {
  const dir = await mkdtemp(join(tmpdir(), "hh-audio-"));
  try {
    const input = join(dir, "in.bin"); // ffmpeg probes the container; the extension doesn't matter
    const output = join(dir, "out.mp3");
    await writeFile(input, audio.data);
    await new Promise<void>((resolve, reject) => {
      execFile(
        "ffmpeg",
        ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", output],
        { timeout: 30_000 },
        (err, _stdout, stderr) => {
          if (!err) return resolve();
          const reason = (stderr || err.message).trim().slice(-300);
          reject(new Error(`the recording has no decodable audio (ffmpeg: ${reason})`));
        },
      );
    });
    return { data: new Uint8Array(await readFile(output)), mime: "audio/mpeg", filename: "capture.mp3" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
