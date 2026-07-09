// tests/news-parse.test.js — parseNewsRss extracts headline/link/publisher/date from
// Google News RSS, decodes entities/CDATA, and strips the trailing " - Publisher".
const assert = require("assert");
const { parseNewsRss } = require("../core/news.js");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

const XML = `<?xml version="1.0"?><rss><channel>
<item>
  <title>Bees &amp; the art of hive design - The Verge</title>
  <link>https://news.google.com/rss/articles/ABC123</link>
  <pubDate>Wed, 08 Jul 2026 12:00:00 GMT</pubDate>
  <source url="https://www.theverge.com">The Verge</source>
</item>
<item>
  <title><![CDATA[A new lathe for tiny workshops]]></title>
  <link>https://news.google.com/rss/articles/DEF456</link>
  <pubDate>Tue, 07 Jul 2026 09:30:00 GMT</pubDate>
  <source url="https://example.com">Maker Mag</source>
</item>
<item>
  <title>Missing link item</title>
</item>
</channel></rss>`;

const items = parseNewsRss(XML);
ok("parses the two well-formed items (skips the linkless one)", items.length === 2);
ok("decodes entities in the title", items[0].title.indexOf("&amp;") === -1 && items[0].title.indexOf("Bees & the art") === 0);
ok("strips the trailing ' - Publisher'", items[0].title === "Bees & the art of hive design");
ok("keeps the link", items[0].url === "https://news.google.com/rss/articles/ABC123");
ok("captures the publisher", items[0].source === "The Verge");
ok("parses pubDate to epoch ms", items[0].ts === Date.parse("Wed, 08 Jul 2026 12:00:00 GMT"));
ok("handles CDATA titles", items[1].title === "A new lathe for tiny workshops");
ok("bad/empty xml → []", parseNewsRss("") .length === 0 && parseNewsRss(null).length === 0);

console.log("news-parse: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
