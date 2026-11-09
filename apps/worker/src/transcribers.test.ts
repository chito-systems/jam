import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranscriberFromEnv, OpenAITranscriber } from "./transcribers";

const KEY = "sk-test-secret-key";
const audio = (mime: string, filename?: string) => ({ data: new Uint8Array([1, 2, 3, 4]), mime, filename });

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(status: number, body: unknown) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

function sentFile(call: Call): File {
  const file = (call.init.body as FormData).get("file");
  if (!(file instanceof File)) throw new Error("no file in form");
  return file;
}

describe("OpenAITranscriber request", () => {
  it("posts multipart to /audio/transcriptions with bearer auth and a .webm filename", async () => {
    const { impl, calls } = fakeFetch(200, { text: "", segments: [], duration: 1 });
    const t = new OpenAITranscriber({ apiKey: KEY, fetchImpl: impl });
    await t.transcribe(audio("audio/webm;codecs=opus"));

    expect(t.name).toBe("openai:whisper-1");
    expect(calls).toHaveLength(1);
    const [call] = calls as [Call];
    expect(call.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const form = call.init.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("timestamp_granularities[]")).toBe("segment");
    const file = sentFile(call);
    expect(file.name).toBe("capture.webm");
    expect(file.type).toBe("audio/webm");
    expect(file.size).toBe(4);
  });

  it("uses .mp4 for audio/mp4 and appends an extension to a bare filename", async () => {
    const { impl, calls } = fakeFetch(200, { text: "" });
    const t = new OpenAITranscriber({ apiKey: KEY, fetchImpl: impl, baseUrl: "http://proxy.local/v1/" });
    await t.transcribe(audio("audio/mp4", "memo"));
    const [call] = calls as [Call];
    expect(call.url).toBe("http://proxy.local/v1/audio/transcriptions");
    expect(sentFile(call).name).toBe("memo.mp4");
  });

  it("keeps a filename that already has an extension", async () => {
    const { impl, calls } = fakeFetch(200, { text: "" });
    await new OpenAITranscriber({ apiKey: KEY, fetchImpl: impl }).transcribe(audio("audio/mpeg", "talk.mp3"));
    expect(sentFile(calls[0] as Call).name).toBe("talk.mp3");
  });

  it("sends plain json for non-whisper models", async () => {
    const { impl, calls } = fakeFetch(200, { text: "hi" });
    const t = new OpenAITranscriber({ apiKey: KEY, model: "gpt-4o-transcribe", fetchImpl: impl });
    await t.transcribe(audio("audio/webm"));
    const form = (calls[0] as Call).init.body as FormData;
    expect(t.name).toBe("openai:gpt-4o-transcribe");
    expect(form.get("response_format")).toBe("json");
    expect(form.get("timestamp_granularities[]")).toBeNull();
  });
});

describe("OpenAITranscriber response", () => {
  it("maps verbose_json segments, trimming text and dropping empties", async () => {
    const { impl } = fakeFetch(200, {
      text: "hello there. ship it.",
      duration: 7.5,
      segments: [
        { start: 0, end: 2.1, text: " hello there." },
        { start: 2.1, end: 3, text: "   " },
        { start: 3, end: 7.4, text: " ship it. " },
      ],
    });
    const out = await new OpenAITranscriber({ apiKey: KEY, fetchImpl: impl }).transcribe(audio("audio/webm"));
    expect(out).toEqual({
      duration_s: 7.5,
      segments: [
        { start_s: 0, end_s: 2.1, text: "hello there." },
        { start_s: 3, end_s: 7.4, text: "ship it." },
      ],
    });
  });

  it("falls back to the last segment end when duration is missing", async () => {
    const { impl } = fakeFetch(200, { segments: [{ start: 0, end: 4.2, text: "hi" }] });
    const out = await new OpenAITranscriber({ apiKey: KEY, fetchImpl: impl }).transcribe(audio("audio/webm"));
    expect(out.duration_s).toBe(4.2);
  });

  it("turns a text-only response into one segment", async () => {
    const { impl } = fakeFetch(200, { text: "  we picked elastic  " });
    const out = await new OpenAITranscriber({ apiKey: KEY, fetchImpl: impl }).transcribe(audio("audio/webm"));
    expect(out).toEqual({ duration_s: 0, segments: [{ start_s: 0, end_s: 0, text: "we picked elastic" }] });
  });

  it("returns no segments for silence", async () => {
    const { impl } = fakeFetch(200, { text: "", duration: 3, segments: [] });
    const out = await new OpenAITranscriber({ apiKey: KEY, fetchImpl: impl }).transcribe(audio("audio/webm"));
    expect(out).toEqual({ segments: [], duration_s: 3 });
  });

  it("throws on non-2xx with the status and body, never the key", async () => {
    const { impl } = fakeFetch(401, { error: { message: "Incorrect API key provided" } });
    const t = new OpenAITranscriber({ apiKey: KEY, fetchImpl: impl });
    const err = await t.transcribe(audio("audio/webm")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("401");
    expect(msg).toContain("Incorrect API key provided");
    expect(msg).not.toContain(KEY);
  });
});

describe("createTranscriberFromEnv", () => {
  afterEach(() => vi.restoreAllMocks());

  it("builds an OpenAI transcriber when TRANSCRIBER is unset and a key is present", () => {
    const t = createTranscriberFromEnv({ OPENAI_API_KEY: KEY });
    expect(t).toBeInstanceOf(OpenAITranscriber);
    expect(t?.name).toBe("openai:whisper-1");
  });

  it("honors TRANSCRIBER=openai and OPENAI_TRANSCRIBE_MODEL", () => {
    const t = createTranscriberFromEnv({
      TRANSCRIBER: "openai",
      OPENAI_API_KEY: KEY,
      OPENAI_TRANSCRIBE_MODEL: "gpt-4o-mini-transcribe",
    });
    expect(t?.name).toBe("openai:gpt-4o-mini-transcribe");
  });

  it("returns undefined without a key", () => {
    expect(createTranscriberFromEnv({ TRANSCRIBER: "openai" })).toBeUndefined();
    expect(createTranscriberFromEnv({ OPENAI_API_KEY: "" })).toBeUndefined();
  });

  it("warns and returns undefined for TRANSCRIBER=local", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(createTranscriberFromEnv({ TRANSCRIBER: "local", OPENAI_API_KEY: KEY })).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});
