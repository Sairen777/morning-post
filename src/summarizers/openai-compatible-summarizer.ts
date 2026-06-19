import { jsonrepair } from "jsonrepair";
import type { NormalizedItem } from "../connectors/connector.types.ts";
import type {
  ContentPart,
  ImagePart,
  SummarizerService,
  SummarizeOptions,
  SummaryPoint,
  SummaryRuleset,
  TextPart,
} from "./summarizer.types.ts";
import { isEmojiOnly } from "../utils/text.ts";

const DEFAULTS = Deno.env.get("LOCAL_API") === "true"
  ? {
    model: "gemma-4-e4b-uncensored-hauhaucs-aggressive",
    // LM Studio
    baseUrl: "http://localhost:1234/v1",
    apiKey: undefined as string | undefined,
  }
  : {
    model: "gemini-2.5-flash-lite",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: Deno.env.get("GEMINI_API_KEY"),
  };

export class OpenAICompatibleSummarizerService implements SummarizerService {
  constructor(
    private model: string = Deno.env.get("SUMMARIZER_MODEL") ?? DEFAULTS.model,
    private baseUrl: string = Deno.env.get("SUMMARIZER_BASE_URL") ??
      DEFAULTS.baseUrl,
    private apiKey: string | undefined = DEFAULTS.apiKey,
  ) {}

  public async summarize(
    items: NormalizedItem[],
    rules: SummaryRuleset,
    options: SummarizeOptions = {},
  ): Promise<SummaryPoint[]> {
    const { parts, indexedItems } = await this.buildContentParts(items, rules);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey && { Authorization: `Bearer ${this.apiKey}` }),
      },
      body: JSON.stringify({
        model: options.model ?? this.model,
        stream: false,
        messages: [
          { role: "system", content: rules.systemPrompt },
          { role: "user", content: parts },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Request failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = await response.json();
    const raw = data.choices[0].message.content as string;
    return this.parsePoints(raw, indexedItems);
  }

  private async buildContentParts(
    items: NormalizedItem[],
    rules: SummaryRuleset,
  ): Promise<{
    parts: ContentPart[] | string;
    indexedItems: NormalizedItem[];
  }> {
    const showAuthors = rules.showAuthors ?? false;
    const includeMedia = rules.includeMedia ?? true;
    const parts: ContentPart[] = [];
    const indexedItems: NormalizedItem[] = [];

    // WARNING: for large group chats (300+ messages) this sends all messages in a single
    // request and may overflow the model's context window. Options if that becomes a problem:
    //   1. Hard cap — slice to the last N items before calling this method
    //   2. Time-window cap — caller filters to a shorter period
    //   3. Chunked summarization — split into batches of ~50, summarize each, then
    //      summarize the intermediate summaries (most accurate for long threads)

    // The OpenAI vision API requires images to be separate image_url objects in
    // the content array — base64 cannot be embedded inside a text part.
    // Association between text and images is positional: the model treats all
    // consecutive image_url parts following a text part as belonging to that text.
    for (const item of items) {
      const hasPhoto = item.media?.type === "photo" ||
        item.media?.type === "album";
      if (!item.text.trim() && !hasPhoto) continue;
      if (isEmojiOnly(item.text) && !hasPhoto) continue;

      const i = indexedItems.length;
      indexedItems.push(item);

      const header = showAuthors
        ? `[${i}] ${item.author ?? "Unknown"}`
        : `[${i}]`;
      parts.push({ type: "text", text: `${header}\n${item.text}` });

      if (includeMedia) {
        if (item.media?.type === "photo") {
          parts.push(await this.imagePartFromPath(item.media.localPath));
        } else if (item.media?.type === "album") {
          for (const localPath of item.media.localPaths) {
            parts.push(await this.imagePartFromPath(localPath));
          }
        }
      }
    }

    // No images? collapse to a plain string to avoid the {"type":"text","text":...}
    // wrapper overhead on every message.
    const hasAnyImage = parts.some((p) => p.type === "image_url");
    if (!hasAnyImage) {
      const text = parts.map((p) => (p as TextPart).text).join("\n\n");
      return { parts: text, indexedItems };
    }

    return { parts, indexedItems };
  }

  private parsePoints(
    raw: string,
    indexedItems: NormalizedItem[],
  ): SummaryPoint[] {
    // Strip <think>...</think> reasoning tokens (Qwen3, DeepSeek-R1, etc.) first,
    // then let jsonrepair handle malformed JSON, fences, and other LLM quirks.
    const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    const json = jsonrepair(stripped);

    const parsed = JSON.parse(json) as Array<{ t: string; i: number }>;

    return parsed.map((p) => {
      const item = indexedItems[p.i];
      return {
        text: p.t,
        sourceUrl: item?.url ?? null,
        ...(item && {
          channel: item.feedExternalId,
          date: new Date(item.date).toLocaleString("en-GB", {
            day: "numeric",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }),
        }),
      };
    });
  }

  private async imagePartFromPath(localPath: string): Promise<ImagePart> {
    const bytes = await Deno.readFile(localPath);
    const b64 = btoa(String.fromCharCode(...bytes));
    return {
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${b64}` },
    };
  }
}
