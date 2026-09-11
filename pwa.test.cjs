const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function worker() {
  const scope = "https://example.test/museum-sensor-logger/";
  const listeners = {};
  const stores = new Map();
  let isOffline = false;
  let claimCount = 0;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const files = stores.get(name);
      return {
        async addAll(requests) {
          for (const request of requests) {
            const relative = new URL(request.url).pathname.replace("/museum-sensor-logger/", "") || "index.html";
            files.set(request.url, new Response(fs.readFileSync(path.join(__dirname, relative))));
          }
        },
        async match(url) { return files.get(url)?.clone(); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  const context = {
    URL, Request, Response, caches,
    fetch: async () => { if (isOffline) throw new Error("offline"); return new Response("network"); },
    self: {
      registration: { scope },
      clients: { claim: async () => { claimCount++; } },
      addEventListener: (name, fn) => { listeners[name] = fn; },
    },
  };
  vm.runInNewContext(fs.readFileSync(__dirname + "/sw.js", "utf8"), context);
  async function lifecycle(name) {
    let pending;
    listeners[name]({waitUntil: promise => { pending = promise; }});
    await pending;
  }
  async function request(url, method = "GET") {
    let response;
    listeners.fetch({request:new Request(url, {method}),respondWith: promise => {response = promise;}});
    return response ? await response : undefined;
  }
  return { scope, stores, lifecycle, request, offline: () => {isOffline = true;}, claims:()=>claimCount };
}

test("公開サブディレクトリでも初回キャッシュ後はHTML・アイコンをオフライン配信する", async () => {
  const app = worker();
  await app.lifecycle("install");
  await app.lifecycle("activate");
  app.offline();
  const response = await app.request(app.scope + "room_logger.html?test=1");
  assert.match(await response.text(), /博物館センサ記録/);
  assert.match(await (await app.request(app.scope)).text(), /room_logger.html/);
  const icon = await app.request(app.scope + "icons/icon-192.png");
  const bytes = Buffer.from(await icon.arrayBuffer());
  assert.equal(bytes.toString("hex", 0, 8), "89504e470d0a1a0a");
  assert.equal(bytes.readUInt32BE(16), 192);
  assert.equal(app.claims(), 1);
});

test("更新時に同じアプリの旧キャッシュだけ削除し、別アプリは保持する", async () => {
  const app = worker();
  const old = "museum-sensor-shell:" + app.scope + ":old";
  const other = "museum-sensor-shell:https://example.test/other/:v1";
  app.stores.set(old, new Map());
  app.stores.set(other, new Map());
  await app.lifecycle("install");
  await app.lifecycle("activate");
  assert.equal(app.stores.has(old), false);
  assert.equal(app.stores.has(other), true);
});

test("別サイト・未知のパス・POSTはキャッシュ処理の対象外", async () => {
  const app = worker();
  assert.equal(await app.request("https://elsewhere.test/"), undefined);
  assert.equal(await app.request(app.scope + "records.csv"), undefined);
  assert.equal(await app.request(app.scope + "room_logger.html", "POST"), undefined);
});

test("manifestの起動先と全アイコンが実在し、PNGサイズと一致する", () => {
  const manifest = JSON.parse(fs.readFileSync(__dirname + "/manifest.json"));
  assert.equal(manifest.display, "standalone");
  assert.ok(fs.existsSync(path.join(__dirname, manifest.start_url)));
  for (const icon of manifest.icons) {
    const bytes = fs.readFileSync(path.join(__dirname, icon.src));
    assert.equal(bytes.readUInt32BE(16), Number(icon.sizes.split("x")[0]));
    assert.equal(bytes.readUInt32BE(20), Number(icon.sizes.split("x")[1]));
  }
});
