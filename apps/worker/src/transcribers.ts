// Transcribers for the worker. OpenAI today (plain fetch, no SDK); local whisper.cpp later.
import type { Transcriber, Transcript, TranscriptSegment } from "@hh/shared";
import { withSpan } from "@hh/shared";

type FetchImpl = typeof fetch;

export interface OpenAITranscriberOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: FetchImpl;
}

interface OpenAITranscriptionResponse {
  text?: string;
  duration?: number;
  segments?: Array<{ start?: number; end?: number; text?: string }>;
}

const TIMEOUT_MS = 60_000;

/** `audio/webm;codecs=opus` → `audio/webm`. */
export function baseMime(mime: string): string {
  return (mime.split(";")[0] ?? "").trim().toLowerCase();
}

/** The API infers the format from the filename extension, so pick one from the mime. */
export function extensionForMime(mime: string): string {
  const m = baseMime(mime);
  if (m.startsWith("audio/webm")) return ".webm";
  if (["audio/mp4", "audio/m4a", "audio/x-m4a", "video/mp4"].includes(m)) return ".mp4";
  if (m === "audio/mpeg") return ".mp3";
  if (m === "audio/wav" || m === "audio/x-wav") return ".wav";
  if (m.startsWith("audio/ogg")) return ".ogg";
  return ".webm";
}

/** Keeps the given filename if it already has an extension; otherwise derives one from the mime. */
export function uploadFilename(mime: string, filename?: string): string {
  const name = filename?.trim();
  if (name && /\.[a-z0-9]+$/i.test(name)) return name;
  return `${name || "capture"}${extensionForMime(mime)}`;
}

export function parseTranscription(body: OpenAITranscriptionResponse): Transcript {
  const segments: TranscriptSegment[] = (body.segments ?? [])
    .map((s) => ({ start_s: s.start ?? 0, end_s: s.end ?? 0, text: (s.text ?? "").trim() }))
    .filter((s) => s.text.length > 0);
  const lastEnd = segments.at(-1)?.end_s;
  const duration_s = body.duration ?? lastEnd ?? 0;
  if (segments.length > 0) return { segments, duration_s };
  const text = (body.text ?? "").trim();
  if (!text) return { segments: [], duration_s };
  return { segments: [{ start_s: 0, end_s: duration_s, text }], duration_s };
}

export class OpenAITranscriber implements Transcriber {
  readonly name: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: OpenAITranscriberOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model || "whisper-1";
    this.baseUrl = (opts.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.name = `openai:${this.model}`;
  }

  transcribe(audio: { data: Uint8Array; mime: string; filename?: string }): Promise<Transcript> {
    const mime = baseMime(audio.mime);
    return withSpan(
      "transcribe.openai",
      { model: this.model, bytes: audio.data.byteLength, mime },
      async (span) => {
        const form = new FormData();
        // Copy into a fresh ArrayBuffer-backed view so Blob accepts it regardless of the source buffer type.
        const blob = new Blob([new Uint8Array(audio.data)], { type: mime });
        form.append("file", blob, uploadFilename(mime, audio.filename));
        form.append("model", this.model);
        // Only whisper models support verbose_json + segment timestamps; newer models return text only.
        if (this.model.startsWith("whisper")) {
          form.append("response_format", "verbose_json");
          form.append("timestamp_granularities[]", "segment");
        } else {
          form.append("response_format", "json");
        }

        const res = await this.fetchImpl(`${this.baseUrl}/audio/transcriptions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}` },
          body: form,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) {
          const body = (await res.text().catch(() => "")).slice(0, 300);
          throw new Error(`OpenAI transcription failed: ${res.status} ${res.statusText} ${body}`.trim());
        }

        const transcript = parseTranscription((await res.json()) as OpenAITranscriptionResponse);
        span.setAttribute("duration_s", transcript.duration_s);
        span.setAttribute("segments", transcript.segments.length);
        return transcript;
      },
    );
  }
}

/** Picks a transcriber from env (TRANSCRIBER, OPENAI_API_KEY). Undefined if not configured. */
export function createTranscriberFromEnv(env: NodeJS.ProcessEnv): Transcriber | undefined {
  const kind = (env.TRANSCRIBER || "openai").trim().toLowerCase();
  if (kind === "local") {
    console.warn("TRANSCRIBER=local: the local transcriber isn't built yet; audio captures won't transcribe.");
    return undefined;
  }
  if (kind !== "openai") {
    console.warn(`Unknown TRANSCRIBER=${kind}; audio captures won't transcribe.`);
    return undefined;
  }
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return undefined;
  return new OpenAITranscriber({
    apiKey,
    model: env.OPENAI_TRANSCRIBE_MODEL?.trim() || undefined,
    baseUrl: env.OPENAI_BASE_URL?.trim() || undefined,
  });
}
