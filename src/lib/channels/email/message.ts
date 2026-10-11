import { simpleParser } from "mailparser";

export interface ReadMessage {
  html: string | null;
  text: string | null;
}

/** The HTML and plain-text bodies of a raw RFC 822 message. Throws when it cannot be parsed at all. */
export async function readMessage(source: Buffer): Promise<ReadMessage> {
  const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true, skipHtmlToText: true });
  return {
    html: typeof parsed.html === "string" && parsed.html.trim().length > 0 ? parsed.html : null,
    text: typeof parsed.text === "string" && parsed.text.trim().length > 0 ? parsed.text : null,
  };
}
