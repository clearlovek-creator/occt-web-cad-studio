import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const request = new Request("http://localhost/", { headers: { accept: "text/html" } });
  return typeof worker === "function" ? worker(request) : worker.fetch(
    request,
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server renders the OCCT Web Studio shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>OCCT Web Studio<\/title>/i);
  assert.match(html, /建模功能区/);
  assert.match(html, /基础体/);
  assert.match(html, /圆柱体/);
  assert.match(html, /工程管理/);
  assert.doesNotMatch(html, /仿真管理|草图|多段线/);
  assert.doesNotMatch(html, /class="menu-bar"/);
  assert.match(html, /OCCT Web Studio/);
  assert.match(html, /data-testid="feature-tree"/);
  assert.doesNotMatch(html, />参数与历史</);
  assert.doesNotMatch(html, /INSPECTOR|属性 \/ 建模/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});
