import { convert } from "html-to-text";
import { ConnectorId } from "../../constants.ts";
import type {
  Connector,
  NormalizedData,
  NormalizedItem,
} from "../connector.types.ts";
import {
  type ArchiveItem,
  type PublicArchivePage,
  readPublicArchive,
} from "./publication-reader.ts";
import type { SubstackPrivatePost } from "./session-client.ts";

const ARCHIVE_PAGE_SIZE = 50;

const isSupportedArchivePostType = (type: string): boolean =>
  type === "newsletter" || type === "podcast";

export type PublicationPageReader = (
  publicationUrl: string,
  offset: number,
  limit: number,
  signal?: AbortSignal,
) => Promise<PublicArchivePage>;

export interface SubstackPostReader {
  getPostById(
    postId: number,
    signal?: AbortSignal,
  ): Promise<SubstackPrivatePost | null>;
}

export interface SubstackRawPost {
  preview: ArchiveItem;
  privatePost: SubstackPrivatePost | null;
}

export type SubstackRawData = Record<string, {
  feedName: string;
  posts: SubstackRawPost[];
}>;

const defaultPublicationReader: PublicationPageReader = (
  publicationUrl,
  offset,
  limit,
  signal,
) => readPublicArchive(publicationUrl, {}, offset, limit, signal);

export class SubstackConnector implements Connector<SubstackRawData> {
  constructor(
    private readonly postReader: SubstackPostReader,
    private readonly publicationReader: PublicationPageReader =
      defaultPublicationReader,
  ) {}

  public async getRawData(
    from: number,
    to: number,
    feedExternalIds?: string[],
    signal?: AbortSignal,
  ): Promise<SubstackRawData> {
    const result: SubstackRawData = {};
    if (!feedExternalIds || feedExternalIds.length === 0) return result;

    for (const feedExternalId of feedExternalIds) {
      result[feedExternalId] = await this.readPublication(
        feedExternalId,
        from,
        to,
        signal,
      );
    }
    return result;
  }

  public async getNormalizedData(
    from: number,
    to: number,
    feedExternalIds?: string[],
    signal?: AbortSignal,
  ): Promise<NormalizedData> {
    const rawData = await this.getRawData(from, to, feedExternalIds, signal);
    const result: NormalizedData = {};
    for (const [feedExternalId, publication] of Object.entries(rawData)) {
      result[feedExternalId] = publication.posts.map((
        { preview, privatePost },
      ) =>
        this.normalizePost(
          feedExternalId,
          publication.feedName,
          preview,
          privatePost,
        )
      );
    }
    return result;
  }

  private async readPublication(
    feedExternalId: string,
    from: number,
    to: number,
    signal?: AbortSignal,
  ): Promise<{ feedName: string; posts: SubstackRawPost[] }> {
    const posts: SubstackRawPost[] = [];
    const seenPostIds = new Set<number>();
    const seenPages = new Set<string>();
    let feedName = new URL(feedExternalId).hostname;
    let offset = 0;

    while (true) {
      const page = await this.publicationReader(
        feedExternalId,
        offset,
        ARCHIVE_PAGE_SIZE,
        signal,
      );
      if (page.items.length === 0) break;
      const pageSignature = page.items.map((item) => item.id).join(",");
      if (seenPages.has(pageSignature)) {
        throw new Error("Substack archive pagination made no progress");
      }
      seenPages.add(pageSignature);
      feedName = page.items.find((item) =>
        item.publicationName
      )?.publicationName ?? feedName;

      for (const preview of page.items) {
        if (seenPostIds.has(preview.id)) continue;
        seenPostIds.add(preview.id);
        if (
          !isSupportedArchivePostType(preview.type) ||
          preview.postDate < from ||
          preview.postDate > to
        ) continue;
        const privatePost = await this.postReader.getPostById(
          preview.id,
          signal,
        );
        if (
          privatePost &&
          (privatePost.id !== preview.id ||
            privatePost.publicationId !== preview.publicationId)
        ) {
          throw new Error(
            "Substack private post does not match archive preview",
          );
        }
        posts.push({ preview, privatePost });
      }

      if (page.items.every((item) => item.postDate < from)) break;
      offset += page.items.length;
    }

    return { feedName, posts };
  }

  private normalizePost(
    feedExternalId: string,
    feedName: string,
    preview: ArchiveItem,
    privatePost: SubstackPrivatePost | null,
  ): NormalizedItem {
    const canUsePrivateBody = preview.audience !== "only_paid" ||
      privatePost?.hasPaidSubscription === true;
    const fullText = canUsePrivateBody && privatePost?.bodyHtml
      ? normalizeHtml(privatePost.bodyHtml)
      : "";
    if (
      preview.audience === "only_paid" &&
      privatePost?.hasPaidSubscription === true &&
      fullText.length === 0
    ) {
      throw new Error(
        "Substack returned an empty body for an accessible paid post",
      );
    }
    const text = fullText ||
      preview.truncatedBodyText ||
      preview.description ||
      preview.subtitle ||
      preview.title;
    return {
      connectorId: ConnectorId.Substack,
      feedExternalId,
      externalId: preview.id.toString(),
      date: preview.postDate,
      title: preview.title,
      text,
      author: preview.publishedBylines?.find((byline) => byline.name)?.name ??
        preview.publicationName ?? feedName,
      url: safeHttpUrl(preview.canonicalUrl),
      meta: {
        audience: preview.audience,
        contentAccess: fullText ? "full" : "preview",
        hasPaidSubscription: privatePost?.hasPaidSubscription === true,
      },
    };
  }
}

function normalizeHtml(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
    ],
  }).trim();
}

function safeHttpUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}
