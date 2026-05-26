import { jsonrepair } from "jsonrepair";
import type {
  NormalizedItem,
  SummaryPoint,
  SummaryRuleset,
  SummarizerService,
} from "./summarizer.types.ts";

type TextPart = { type: "text"; text: string };
type ImagePart = { type: "image_url"; image_url: { url: string } };
type ContentPart = TextPart | ImagePart;

// TODO: put it to utils
// Messages with no letter characters (pure emoji / punctuation / stickers) add noise in group chats.
// "yes" and "no" pass this filter; "👍" and "😂🔥" do not.
function isEmojiOnly(text: string): boolean {
  return !/\p{L}/u.test(text.trim());
}

// TODO: we need to refactor this
// First there will be class AbstractSummarizer with common logic that applies to all items we summarie
// and then this class will be extended by specifici summarizers like TelegramSummarizer
// that will pass specific data like prompt etc
export class OpenAICompatibleSummarizerService implements SummarizerService {
  constructor(
    // TODO: should be an env variable
    // private model: string = "qwen3.6-35b-a3b-uncensored-hauhaucs-aggressive",
    private model: string = "gemma-4-e4b-uncensored-hauhaucs-aggressive",
    // TODO: should be an env variable
    private baseUrl: string = "http://localhost:1234",
  ) {}

  public async summarize(
    items: NormalizedItem[],
    rules: SummaryRuleset,
  ): Promise<SummaryPoint[]> {
    const systemPrompt = this.buildSystemPrompt(rules);
    const { parts, indexedItems } = await this.buildContentParts(items, rules);

    await Deno.mkdir(".debug_logs", { recursive: true });
    await Deno.writeTextFile(
      `.debug_logs/contentForSummarizer${rules.mode === "discussion" ? "-discussion" : ""}.json`,
      typeof parts === "string" ? parts : JSON.stringify(parts, null, 2),
    );

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: parts },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "summary_points",
            strict: true,
            schema: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  t: { type: "string" },
                  i: { type: "integer" },
                },
                required: ["t", "i"],
                additionalProperties: false,
              },
            },
          },
        },
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

  private buildSystemPrompt(rules: SummaryRuleset): string {
    const indexInstruction = `Each message starts with [N] where N is its index number. Return a JSON array only — no markdown, no extra text. Each element must have exactly two fields: "t" (the summary bullet as a plain string) and "i" (the integer N of the primary source message). If a bullet covers multiple posts, use the index of the first/primary one.`;

    let parts: string[];

    if (rules.mode === "discussion") {
      parts = [
        "You are a discussion summarizer analyzing a group chat.",
        "Messages may contain a [QUOTED_MESSAGE]...[/QUOTED_MESSAGE] block — this is the message being replied to. Use it for context but do not summarize it separately.",
        "Each message starts with [N] on the first line followed by the author name, then the message text.",
        indexInstruction,
        "Identify the main topics discussed. For each topic, describe what positions were expressed and by whom (mention author names when relevant), and any conclusions the group reached.",
      ];
    } else {
      parts = [
        "You are a concise news summarizer.",
        "Messages may contain a [QUOTED_MESSAGE]...[/QUOTED_MESSAGE] block — this is the post being replied to or quoted, providing context for the main message. Use it to better understand the main message but do not summarize the quote separately.",
        indexInstruction,
      ];
    }

    parts.push(
      rules.language
        ? `Write all "t" values in ${rules.language}.`
        : `Write all "t" values in the same language as the source messages.`,
    );
    if (rules.focus) parts.push(`Focus on: ${rules.focus}.`);
    if (rules.maxLength)
      parts.push(`Keep each bullet under ${rules.maxLength} characters.`);

    return parts.join(" ");
  }

  private async buildContentParts(
    items: NormalizedItem[],
    rules: SummaryRuleset,
  ): Promise<{
    parts: ContentPart[] | string;
    indexedItems: NormalizedItem[];
  }> {
    const parts: ContentPart[] = [];
    const indexedItems: NormalizedItem[] = [];
    const isDiscussion = rules.mode === "discussion";

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
    // Structure per item:
    //   { type: "text",      text: "[N]\nCaption..." }
    //   { type: "image_url", image_url: { url: "data:image/jpeg;base64,..." } }  <- photo 1
    //   { type: "image_url", image_url: { url: "data:image/jpeg;base64,..." } }  <- photo 2 (album)
    //   ...next item...
    for (const item of items) {
      const hasPhoto =
        item.media?.type === "photo" || item.media?.type === "album";
      if (!item.text.trim() && !hasPhoto) continue;
      if (isEmojiOnly(item.text) && !hasPhoto) continue;

      const i = indexedItems.length;
      indexedItems.push(item);

      const header = isDiscussion
        ? `[${i}] ${item.author ?? "Unknown"}`
        : `[${i}]`;
      parts.push({ type: "text", text: `${header}\n${item.text}` });

      // skip images in discussion mode — group chat photos are usually memes
      if (!isDiscussion) {
        if (item.media?.type === "photo") {
          parts.push(await this.imagePartFromPath(item.media.localPath));
        } else if (item.media?.type === "album") {
          for (const localPath of item.media.localPaths) {
            parts.push(await this.imagePartFromPath(localPath));
          }
        }
      }
    }

    // discussion mode has no images — collapse to a plain string to avoid
    // the {"type":"text","text":...} wrapper overhead on every message
    if (isDiscussion) {
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
          channel: item.sourceId,
          date: item.date.toLocaleString("en-GB", {
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
