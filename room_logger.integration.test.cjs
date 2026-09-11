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

test("施設リセットの確認は1回で、施設名とイベント件数を示しキャンセルなら全件を残す", t => {
  const app = launch(); t.after(app.close);
  app.prepare(); app.record(1); app.record(2);
  app.input("facilitySelect", "seimei"); app.record(3);
  app.input("facilitySelect", "kahaku");
  const before = app.window.localStorage.getItem(key);
  const confirmations = [];
  app.window.confirm = message => { confirmations.push(message); return false; };
  assert.ok(app.byId("resetFacilityRecordsButton"), "施設リセットボタンがある");
  app.byId("resetFacilityRecordsButton").click();
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0], /国立科学博物館/);
  assert.match(confirmations[0], /2件/);
  assert.match(confirmations[0], /元に戻せません/);
  assert.equal(app.window.localStorage.getItem(key), before);
  assert.equal(app.document.querySelectorAll("#historyList article").length, 3);
});

test("確定した施設の全記録者の記録だけをリセットし設定と他施設の記録を再起動後も保持する", async t => {
  const app = launch(); t.after(app.close);
  app.prepare(); app.record(20);
  app.input("collectorInput", "別の記録者"); app.record(19);
  app.input("facilitySelect", "seimei"); app.record(10, "B");
  app.input("facilitySelect", "kahaku");
  const before = app.stored();
  assert.equal(app.byId("decreaseSensorCountButton").disabled, true);
  let confirmations = 0;
  app.window.confirm = () => { confirmations++; return true; };
  assert.ok(app.byId("resetFacilityRecordsButton"));
  app.byId("resetFacilityRecordsButton").click();
  assert.equal(confirmations, 1);
  assert.deepEqual(app.stored(), {...before, records:[before.records[2]]});
  assert.equal(app.byId("resetFacilityRecordsButton").disabled, true);
  assert.equal(app.byId("decreaseSensorCountButton").disabled, false);
  assert.match(app.byId("statusTitle").textContent, /センサ10/);
  const restored = launch({saved:app.window.localStorage.getItem(key)}); t.after(restored.close);
  assert.deepEqual(restored.stored(), {...before, records:[before.records[2]]});
  restored.byId("saveCsvButton").click();
  const csv = await restored.readBlob(restored.downloads[0]);
  assert.doesNotMatch(csv, /,kahaku,/);
  assert.match(csv, /,seimei,10,B/);
  restored.record(1);
  assert.equal(restored.stored().records.length, 2);
});

test("選択施設の記録がゼロならリセットできず、切り替えで対象と件数が更新される", t => {
  const app = launch(); t.after(app.close);
  let confirmations = 0;
  app.window.confirm = () => { confirmations++; return true; };
  assert.ok(app.byId("resetFacilityRecordsButton"));
  assert.equal(app.byId("resetFacilityRecordsButton").disabled, true);
  app.byId("resetFacilityRecordsButton").click();
  app.prepare(); app.record(1);
  assert.equal(app.byId("resetFacilityRecordsButton").disabled, false);
  app.input("facilitySelect", "tohaku");
  assert.match(app.byId("resetFacilitySummary").textContent, /東京国立博物館.*0件/);
  assert.equal(app.byId("resetFacilityRecordsButton").disabled, true);
  app.byId("resetFacilityRecordsButton").click();
  assert.equal(confirmations, 0);
  assert.equal(app.stored().records.length, 1);
});

test("リセットの保存に失敗したら画面と保存先に全記録を残してCSVで回収できる", async t => {
  const app = launch(); t.after(app.close);
  app.prepare(); app.record(20);
  const saved = app.window.localStorage.getItem(key);
  app.window.Storage.prototype.setItem = () => { throw new Error("quota"); };
  app.window.confirm = () => true;
  assert.ok(app.byId("resetFacilityRecordsButton"));
  app.byId("resetFacilityRecordsButton").click();
  assert.equal(app.window.localStorage.getItem(key), saved);
  assert.equal(app.document.querySelectorAll("#historyList article").length, 1);
  assert.equal(app.byId("storageWarning").hidden, false);
  assert.match(app.byId("toast").textContent, /削除していません/);
  assert.equal(app.byId("decreaseSensorCountButton").disabled, true);
  app.byId("saveCsvButton").click();
  assert.match(await app.readBlob(app.downloads[0]), /,kahaku,20,A/);
});

test("壊れた保存データは施設リセットでも削除や上書きをしない", t => {
  const app = launch({saved:"{broken"}); t.after(app.close);
  let confirmations = 0;
  app.window.confirm = () => { confirmations++; return true; };
  assert.ok(app.byId("resetFacilityRecordsButton"));
  app.byId("resetFacilityRecordsButton").click();
  assert.equal(confirmations, 0);
  assert.equal(app.byId("resetFacilityRecordsButton").disabled, true);
  assert.equal(app.window.localStorage.getItem(key), "{broken");
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

test("方向説明は施設とセンサ番号に対応し、未設定のボタンには表示しない", t => {
  const app = launch(); t.after(app.close);
  app.window.MuseumLoggerCore.findFacility("kahaku").directionLabels = {
    1: { A: "ロビー → 展示室", B: "展示室 → ロビー" },
    2: { A: "入口 → 奥" },
    3: { A: "  ", B: "" },
  };
  app.window.MuseumLoggerCore.findFacility("seimei").directionLabels = {
    1: { A: "通路 → 展示室" },
  };
  app.input("facilitySelect", "kahaku");
  const firstRow = app.document.querySelector('[data-sensor-row="1"]');
  assert.deepEqual([...firstRow.querySelectorAll(".direction-description")].map(node => node.textContent),
    ["ロビー → 展示室", "展示室 → ロビー"]);
  const descriptionId = firstRow.querySelector("button").getAttribute("aria-describedby");
  assert.equal(app.document.getElementById(descriptionId)?.textContent, "ロビー → 展示室");
  assert.equal(app.document.querySelector('[data-sensor-row="2"]').querySelectorAll(".direction-description").length, 1);
  assert.equal(app.document.querySelector('[data-sensor-row="3"]').querySelectorAll(".direction-description").length, 0);
  app.input("facilitySelect", "seimei");
  assert.deepEqual([...app.byId("sensorGrid").querySelectorAll(".direction-description")].map(node => node.textContent),
    ["通路 → 展示室"]);
  app.input("facilitySelect", "tohaku");
  assert.equal(app.byId("sensorGrid").querySelectorAll(".direction-description").length, 0);
});

test("方向説明中の記号は文字として表示し、記録とCSVはA/Bのまま保持する", async t => {
  const app = launch(); t.after(app.close);
  app.prepare(); app.record(12);
  const before = app.stored().records[0];
  app.window.MuseumLoggerCore.findFacility("kahaku").directionLabels = {
    12: { A: '<b>入口</b> → "展示室"', B: "展示室 → 入口" },
  };
  app.input("facilitySelect", "kahaku");
  const description = app.document.querySelector('[data-sensor-row="12"] .direction-description');
  assert.equal(description?.textContent, '<b>入口</b> → "展示室"');
  assert.equal(description.childElementCount, 0);
  app.record(12, "B");
  assert.deepEqual(app.stored().records[0], before);
  assert.equal(app.stored().records[1].direction, "B");
  app.byId("saveCsvButton").click();
  const csv = await app.readBlob(app.downloads[0]);
  assert.equal(csv.split("\n")[0].replace(/^\uFEFF/, ""),
    "record_id,collector,device_name,device_type,timestamp,facility,sensor_number,direction");
  assert.match(csv, /,kahaku,12,A\n/);
  assert.match(csv, /,kahaku,12,B\n/);
  assert.doesNotMatch(csv, /入口|展示室/);
  assert.equal(app.errors.length, 0);
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

test("センサ数を施設別に増減でき、追加地点の記録・編集と再起動後の保持ができる", t => {
  const app = launch(); t.after(app.close);
  app.prepare();
  assert.ok(app.byId("increaseSensorCountButton"), "センサ追加ボタンがある");
  app.byId("increaseSensorCountButton").click();
  assert.equal(app.byId("sensorGrid").children.length, 21);
  app.record(21, "B");
  assert.equal(app.stored().records[0].sensor_number, 21);
  app.document.querySelector('[aria-label="センサ21の記録を編集"]').click();
  assert.equal(app.byId("recordSensorSelect").options.length, 21);
  app.submit("recordForm");
  assert.equal(app.stored().records[0].direction, "B");
  app.input("facilitySelect", "seimei");
  app.byId("decreaseSensorCountButton").click();
  assert.equal(app.byId("sensorGrid").children.length, 9);
  app.input("facilitySelect", "tohaku");
  assert.equal(app.byId("sensorGrid").children.length, 10);
  const restored = launch({saved:app.window.localStorage.getItem(key)}); t.after(restored.close);
  restored.input("facilitySelect", "kahaku");
  assert.equal(restored.byId("sensorGrid").children.length, 21);
  assert.equal(restored.stored().records[0].sensor_number, 21);
  restored.input("facilitySelect", "seimei");
  assert.equal(restored.byId("sensorGrid").children.length, 9);
  assert.equal(restored.errors.length, 0);
});

test("減らせるのは記録済みの最大番号までで、記録編集と削除後も下限を更新する", t => {
  const app = launch(); t.after(app.close);
  app.prepare(); app.record(12); app.record(8);
  const before = app.stored().records;
  assert.ok(app.byId("decreaseSensorCountButton"), "センサ削減ボタンがある");
  for (let count = 0; count < 10; count++) app.byId("decreaseSensorCountButton").click();
  assert.equal(app.byId("sensorGrid").children.length, 12);
  assert.equal(app.byId("decreaseSensorCountButton").disabled, true);
  assert.deepEqual(app.stored().records, before);
  app.document.querySelector('[aria-label="センサ12の記録を編集"]').click();
  app.input("recordSensorSelect", "10"); app.submit("recordForm");
  assert.equal(app.byId("decreaseSensorCountButton").disabled, false);
  app.byId("decreaseSensorCountButton").click(); app.byId("decreaseSensorCountButton").click();
  assert.equal(app.byId("sensorGrid").children.length, 10);
  assert.equal(app.byId("decreaseSensorCountButton").disabled, true);
  app.window.confirm = () => true;
  app.document.querySelector('[aria-label="センサ10の記録を削除"]').click();
  app.byId("decreaseSensorCountButton").click(); app.byId("decreaseSensorCountButton").click();
  assert.equal(app.byId("sensorGrid").children.length, 8);
  assert.equal(app.byId("decreaseSensorCountButton").disabled, true);
});

test("記録がない施設でも1地点より少なくはできず別端末の初期設定を変えない", t => {
  const app = launch(); t.after(app.close);
  assert.ok(app.byId("decreaseSensorCountButton"));
  for (let count = 0; count < 25; count++) app.byId("decreaseSensorCountButton").click();
  assert.equal(app.byId("sensorGrid").children.length, 1);
  assert.equal(app.byId("decreaseSensorCountButton").disabled, true);
  const other = launch(); t.after(other.close);
  assert.equal(other.byId("sensorGrid").children.length, 20);
});

test("センサ設定の保存失敗を表示し、壊れた既存データは増減操作でも上書きしない", t => {
  const app = launch(); t.after(app.close);
  assert.ok(app.byId("increaseSensorCountButton"));
  app.window.Storage.prototype.setItem = () => {throw new Error("quota");};
  app.byId("increaseSensorCountButton").click();
  assert.equal(app.byId("storageWarning").hidden, false);
  assert.equal(app.byId("sensorGrid").children.length, 21);
  const broken = launch({saved:"{broken"}); t.after(broken.close);
  broken.byId("increaseSensorCountButton").click();
  broken.byId("decreaseSensorCountButton").click();
  assert.equal(broken.byId("sensorGrid").children.length, 20);
  assert.equal(broken.window.localStorage.getItem(key), "{broken");
});

test("旧記録のミリ秒を1列のCSVへ引き継ぎ、保存済み番号に必要なセンサ数を復元する", async t => {
  const oldRecord = {
    record_id:"legacy", collector:"検証者", facility:"kahaku", sensor_number:22, direction:"A",
    timestamp:"2026-09-11T12:43:27+09:00", timestamp_ms:1789098207123,
    devices:[{name:"old-phone",type:"smartphone",address:""}],
  };
  for (const sensorCounts of [undefined, {kahaku:2,seimei:-1,tohaku:"invalid"}]) {
    const app = launch({saved:JSON.stringify({facilityId:"kahaku",collector:"検証者",devices:[],
      selectedDeviceIds:[],records:[oldRecord],sensorCounts})}); t.after(app.close);
    assert.equal(app.byId("sensorGrid").children.length, 22);
    app.document.querySelector('[aria-label="センサ22の記録を編集"]').click();
    assert.equal(app.byId("recordTimestampValue").textContent, "2026-09-11T12:43:27.123+09:00");
    app.submit("recordForm");
    assert.equal(app.stored().records[0].timestamp_ms, 1789098207123);
    app.byId("saveCsvButton").click();
    const csv = await app.readBlob(app.downloads[0]);
    assert.equal(csv.split("\n")[1], "legacy,検証者,old-phone,smartphone,2026-09-11T12:43:27.123+09:00,kahaku,22,A");
    assert.doesNotMatch(csv.split("\n")[0], /timestamp_ms/);
    app.input("facilitySelect", "seimei");
    assert.equal(app.byId("sensorGrid").children.length, 10);
  }
});
