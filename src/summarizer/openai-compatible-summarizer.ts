import type {
  NormalizedItem,
  SummaryRuleset,
  SummarizerService,
} from "./summarizer.types.ts";

type TextPart = { type: "text"; text: string };
type ImagePart = { type: "image_url"; image_url: { url: string } };
type ContentPart = TextPart | ImagePart;

export class OpenAICompatibleSummarizerService implements SummarizerService {
  constructor(
    private model: string = "qwen3.6-35b-a3b-uncensored-hauhaucs-aggressive",
    private baseUrl: string = "http://localhost:1234",
  ) {}

  public async summarize(
    items: NormalizedItem[],
    rules: SummaryRuleset,
  ): Promise<string> {
    const systemPrompt = this.buildSystemPrompt(rules);
    const content = await this.buildContentParts(items);

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Request failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = await response.json();
    return data.choices[0].message.content as string;
  }

  private buildSystemPrompt(rules: SummaryRuleset): string {
    const parts = [
      "You are a concise news summarizer.",
      "Messages may contain a [QUOTED_MESSAGE]...[/QUOTED_MESSAGE] block — this is the post being replied to or quoted, providing context for the main message. Use it to better understand the main message but do not summarize the quote separately.",
    ];

    if (rules.language) parts.push(`Respond in ${rules.language}.`);
    if (rules.focus) parts.push(`Focus on: ${rules.focus}.`);
    if (rules.format) parts.push(`Format the output as: ${rules.format}.`);
    if (rules.maxLength) {
      parts.push(`Keep the summary under ${rules.maxLength} characters.`);
    }

    return parts.join(" ");
  }

  private async buildContentParts(items: NormalizedItem[]): Promise<ContentPart[]> {
    const parts: ContentPart[] = [];

    for (const item of items) {
      const hasPhoto = item.media?.type === "photo" || item.media?.type === "album";
      if (!item.text.trim() && !hasPhoto) continue;

      const date = item.date.toISOString().slice(0, 10);
      parts.push({ type: "text", text: `[${item.sourceId} · ${date}]\n${item.text}` });

      if (item.media?.type === "photo") {
        parts.push(await this.imagePartFromPath(item.media.localPath));
      } else if (item.media?.type === "album") {
        for (const localPath of item.media.localPaths) {
          parts.push(await this.imagePartFromPath(localPath));
        }
      }

      parts.push({ type: "text", text: "---" });
    }

    return parts;
  }

  private async imagePartFromPath(localPath: string): Promise<ImagePart> {
    const bytes = await Deno.readFile(localPath);
    const b64 = btoa(String.fromCharCode(...bytes));
    return { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } };
  }
}
