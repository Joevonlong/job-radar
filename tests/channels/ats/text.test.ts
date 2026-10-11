// @vitest-environment node
import { describe, expect, it } from "vitest";

import { decodeHtml, htmlToText } from "@/lib/channels/ats/text";

describe("htmlToText", () => {
  it("unescapes Greenhouse's entity-escaped markup, strips tags and decodes the inner entities", () => {
    const escaped =
      "&lt;p&gt;Build &lt;strong&gt;LLM&lt;/strong&gt; products &amp;amp; more.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Python&lt;/li&gt;&lt;li&gt;RAG&lt;/li&gt;&lt;/ul&gt;&lt;p&gt;Pay&amp;nbsp;&amp;euro;85k&lt;/p&gt;";
    expect(htmlToText(escaped, { escaped: true })).toBe("Build LLM products & more.\n\n- Python\n- RAG\n\nPay €85k");
  });

  it("handles plain HTML, entities and numeric references", () => {
    expect(htmlToText("<div>Help &amp; support<br>Daily &#8211; &#x20AC;5</div>")).toBe("Help & support\nDaily – €5");
  });

  it("does not treat literal escaped text as markup when the input is not escaped", () => {
    expect(htmlToText("a &lt;b&gt; c")).toBe("a <b> c");
  });

  it("leaves unknown or out-of-range entities alone and tolerates empty input", () => {
    expect(decodeHtml("&bogus; &#99999999999;")).toBe("&bogus; &#99999999999;");
    expect(htmlToText("")).toBe("");
  });
});
