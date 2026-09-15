import test from "node:test";
import assert from "node:assert/strict";
import { createMarkdownProcessor } from "@astrojs/markdown-remark";

test("Markdown footnotes expose stable targets, repeated references, and return links", async () => {
  const processor = await createMarkdownProcessor();
  const { code } =
    await processor.render(`First note.[^margin] Another reference.[^margin]

A second note.[^other]

[^margin]: A longer note with **emphasis** and a [source](https://example.com).

    A second paragraph.

[^other]: Another note.
`);
  assert.equal((code.match(/data-footnote-ref=""/g) || []).length, 3);
  assert.equal((code.match(/data-footnote-backref=""/g) || []).length, 3);
  assert.match(code, /<section data-footnotes=""/);
  assert.match(code, /<li id="user-content-fn-margin">/);
  assert.match(code, /href="#user-content-fn-margin"/);
  assert.match(
    code,
    /<p>A second paragraph\. <a href="#user-content-fnref-margin"/,
  );
  assert.match(code, /<strong>emphasis<\/strong>/);
});
