const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM, VirtualConsole } = require("jsdom");
const html = fs.readFileSync(__dirname + "/room_logger.html", "utf8");
const key = "museum_sensor_ground_truth_v1";

function launch(options = {}) {
  const downloads = [];
  const errors = [];
  const console = new VirtualConsole();
  console.on("jsdomError", error => errors.push(error.message));
  const dom = new JSDOM(html, {
    url: "https://museum.test", runScripts: "dangerously", pretendToBeVisual: true,
    virtualConsole: console,
    beforeParse(window) {
      if (options.saved) window.localStorage.setItem(key, options.saved);
      window.confirm = () => false;
      window.URL.createObjectURL = blob => { downloads.push(blob); return "blob:test"; };
      window.URL.revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = function () {};
    },
  });
  const window = dom.window;
  const document = window.document;
  const byId = id => document.getElementById(id);
  const input = (id, value) => {
    byId(id).value = value;
    byId(id).dispatchEvent(new window.Event("input", { bubbles: true }));
    byId(id).dispatchEvent(new window.Event("change", { bubbles: true }));
  };
  const submit = id => byId(id).dispatchEvent(new window.Event("submit", { cancelable: true }));
  const stored = () => JSON.parse(window.localStorage.getItem(key));
  function addDevice(name, type = "smartphone") {
    byId("addDeviceButton").click();
    input("deviceNameInput", name);
    input("deviceTypeSelect", type);
    input("deviceAddressInput", type === "beacon" ? "00:11:22:33:44:55" : "");
    submit("deviceForm");
  }
  function prepare() {
    input("collectorInput", "検証者");
    addDevice('test,"phone"');
    addDevice("test-beacon", "beacon");
  }
  function record(number = 12, direction = "A") {
    document.querySelector('[aria-label="センサ' + number + '・方向' + direction + 'を記録"]').click();
  }
  const readBlob = blob => new Promise(resolve => {
    const reader = new window.FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsText(blob);
  });
  return { window, document, byId, input, submit, stored, addDevice, prepare, record, downloads, readBlob, errors, close: () => window.close() };
}

test("連打は別IDのイベントになり、2台のスナップショットを保存する", t => {
  const app = launch(); t.after(app.close);
  app.prepare(); app.record(); app.record();
  const records = app.stored().records;
  assert.equal(records.length, 2);
  assert.notEqual(records[0].record_id, records[1].record_id);
  assert.equal(records[0].devices.length, 2);
  assert.equal(records[0].devices[1].address, "00:11:22:33:44:55");
  app.input("collectorInput", "次の記録者");
  assert.equal(app.stored().records[0].collector, "検証者");
  assert.equal(app.errors.length, 0);
});

test("削除キャンセルは記録を残し、確定は選んだ1件だけ削除する", t => {
  const app = launch(); t.after(app.close);
  app.prepare(); app.record(1); app.record(2);
  app.document.querySelector('[aria-label="センサ1の記録を削除"]').click();
  assert.equal(app.stored().records.length, 2);
  app.window.confirm = () => true;
  app.document.querySelector('[aria-label="センサ1の記録を削除"]').click();
  assert.equal(app.stored().records.length, 1);
  assert.equal(app.stored().records[0].sensor_number, 2);
});

test("履歴編集と再起動でID・時刻・MACアドレスを保持する", t => {
  const app = launch(); t.after(app.close);
  app.prepare(); app.record();
  const before = app.stored().records[0];
  app.document.querySelector('[aria-label="センサ12の記録を編集"]').click();
  assert.equal(app.byId("recordTimestampValue").tagName, "TIME");
  app.input("recordSensorSelect", "13");
  app.document.querySelector('input[name="recordDirection"][value="B"]').checked = true;
  app.submit("recordForm");
  const saved = app.window.localStorage.getItem(key);
  const restored = launch({ saved }); t.after(restored.close);
  assert.deepEqual(restored.stored().records[0], {...before, sensor_number:13, direction:"B"});
  assert.match(restored.byId("historySummary").textContent, /1件/);
});

test("3施設の切り替えは20・10・10地点を表示し施設IDを保存する", t => {
  const app = launch(); t.after(app.close);
  app.prepare();
  for (const [id, count] of [["kahaku",20],["seimei",10],["tohaku",10]]) {
    app.input("facilitySelect", id);
    assert.equal(app.byId("sensorGrid").children.length, count);
    app.record(count, "B");
    assert.equal(app.stored().records.at(-1).facility, id);
  }
});

test("CSV保存は2台を2行に展開しMACを出力しない", async t => {
  const app = launch(); t.after(app.close);
  app.prepare(); app.record();
  app.byId("saveCsvButton").click();
  assert.equal(app.downloads.length, 1);
  const csv = await app.readBlob(app.downloads[0]);
  assert.equal(csv.trim().split("\n").length, 3);
  assert.match(csv, /"test,""phone"""/);
  assert.doesNotMatch(csv, /00:11:22/);
  assert.equal(csv.split("\n")[1].split(",")[0], csv.split("\n")[2].split(",")[0]);
});

test("共有非対応ならCSVファイル保存へ切り替える", async t => {
  const app = launch(); t.after(app.close);
  app.prepare(); app.record();
  app.byId("shareCsvButton").click();
  assert.equal(app.downloads.length, 1);
  assert.match(await app.readBlob(app.downloads[0]), /test-beacon/);
});

test("共有キャンセルでは追加ダウンロードせず共有失敗では保存する", async t => {
  const app = launch(); t.after(app.close);
  app.prepare(); app.record();
  app.window.navigator.canShare = () => true;
  app.window.navigator.share = async () => { throw Object.assign(new Error("cancel"), {name:"AbortError"}); };
  app.byId("shareCsvButton").click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.downloads.length, 0);
  app.window.navigator.share = async () => { throw new Error("failed"); };
  app.byId("shareCsvButton").click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.downloads.length, 1);
});

test("デバイス名変更・削除後も過去のイベント情報は変わらない", t => {
  const app = launch(); t.after(app.close);
  app.prepare(); app.record();
  const before = app.stored().records[0];
  app.document.querySelector('[aria-label="test-beaconを編集"]').click();
  app.input("deviceNameInput", "renamed");
  app.submit("deviceForm");
  app.document.querySelector('[aria-label="renamedを編集"]').click();
  app.window.confirm = () => true;
  app.byId("deleteDeviceButton").click();
  assert.equal(app.stored().devices.length, 1);
  assert.deepEqual(app.stored().records[0], before);
});

test("保存容量超過を常時表示し、未保存イベントもCSVから回収できる", async t => {
  const app = launch(); t.after(app.close);
  app.prepare();
  app.window.Storage.prototype.setItem = () => { throw new Error("quota"); };
  app.record();
  assert.equal(app.byId("storageWarning").hidden, false);
  assert.match(app.byId("statusTitle").textContent, /未保存/);
  app.byId("saveCsvButton").click();
  assert.match(await app.readBlob(app.downloads[0]), /test-beacon/);
});

test("壊れた保存データは上書きせず記録を停止する", t => {
  const app = launch({saved:"{broken"}); t.after(app.close);
  app.prepare(); app.record();
  assert.equal(app.window.localStorage.getItem(key), "{broken");
  assert.equal(app.byId("storageWarning").hidden, false);
  assert.equal(app.byId("historyList").querySelectorAll("article").length, 0);
});

test("読めない記録が混ざっていてもその行を破棄して上書きしない", t => {
  const saved = JSON.stringify({facilityId:"kahaku",collector:"検証者",devices:[],selectedDeviceIds:[],records:[{record_id:"broken"}]});
  const app = launch({saved}); t.after(app.close);
  app.prepare(); app.record();
  assert.equal(app.window.localStorage.getItem(key), saved);
  assert.equal(app.byId("storageWarning").hidden, false);
});
