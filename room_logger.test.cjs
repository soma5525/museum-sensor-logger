const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadMuseumLoggerCore() {
  const htmlPath = path.join(__dirname, "room_logger.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  const scriptMatch = html.match(/<script id="museumLoggerCore">([\s\S]*?)<\/script>/);

  assert.ok(scriptMatch, "museumLoggerCore script is present");

  const context = {
    window: {},
    crypto: { randomUUID: () => "generated-id" },
    Date,
  };
  vm.runInNewContext(scriptMatch[1], context);
  return context.window.MuseumLoggerCore;
}

function sampleSettings() {
  return {
    facilityId: "kahaku",
    collector: "平尾",
    devices: [
      {
        id: "device-phone",
        name: 'Daichi, "test" iPhone',
        type: "smartphone",
        address: "",
      },
      {
        id: "device-beacon",
        name: "beacon-21",
        type: "beacon",
        address: "1c:34:f1:ad:13:b5",
      },
    ],
  };
}

test("施設設定は正式名称と初期センサ数20/10/10を提供する", () => {
  const core = loadMuseumLoggerCore();

  assert.deepEqual(
    JSON.parse(JSON.stringify(core.FACILITIES)),
    [
      { id: "kahaku", name: "国立科学博物館", sensorCount: 20 },
      { id: "seimei", name: "神奈川県立生命の星・地球博物館", sensorCount: 10 },
      { id: "tohaku", name: "東京国立博物館", sensorCount: 10 },
    ],
  );
});

test("A/B押下時の設定と時刻を1つの通過イベントへ固定する", () => {
  const core = loadMuseumLoggerCore();
  const capturedAt = new Date("2026-09-11T03:43:27.123Z");

  const record = core.createPassageRecord(
    sampleSettings(),
    12,
    "A",
    capturedAt,
    () => "r-fixed",
  );

  assert.equal(record.record_id, "r-fixed");
  assert.equal(record.collector, "平尾");
  assert.equal(record.facility, "kahaku");
  assert.equal(record.sensor_number, 12);
  assert.equal(record.direction, "A");
  assert.equal(record.timestamp, "2026-09-11T12:43:27+09:00");
  assert.equal(record.timestamp_ms, 1789098207123);
  assert.deepEqual(
    JSON.parse(JSON.stringify(record.devices)),
    [
      { name: 'Daichi, "test" iPhone', type: "smartphone", address: "" },
      { name: "beacon-21", type: "beacon", address: "1c:34:f1:ad:13:b5" },
    ],
  );
});

test("履歴編集はセンサ番号と方向だけを変更し記録時刻を保持する", () => {
  const core = loadMuseumLoggerCore();
  const original = core.createPassageRecord(
    sampleSettings(),
    12,
    "A",
    new Date("2026-09-11T03:43:27.123Z"),
    () => "r-fixed",
  );

  const revised = core.revisePassageRecord(original, {
    sensorNumber: 13,
    direction: "B",
  });

  assert.equal(revised.sensor_number, 13);
  assert.equal(revised.direction, "B");
  assert.equal(revised.timestamp, original.timestamp);
  assert.equal(revised.timestamp_ms, original.timestamp_ms);
  assert.equal(revised.record_id, original.record_id);
  assert.deepEqual(
    JSON.parse(JSON.stringify(revised.devices)),
    JSON.parse(JSON.stringify(original.devices)),
  );
});

test("CSVは1デバイス1行へ展開し同じrecord_idでイベントを結ぶ", () => {
  const core = loadMuseumLoggerCore();
  const record = core.createPassageRecord(
    sampleSettings(),
    12,
    "A",
    new Date("2026-09-11T03:43:27.123Z"),
    () => "r-fixed",
  );

  const csv = core.recordsToCsv([record]);
  const lines = csv.slice(0, -1).split("\n");

  assert.equal(
    lines[0],
    "\uFEFFrecord_id,collector,device_name,device_type,timestamp,timestamp_ms,facility,sensor_number,direction",
  );
  assert.equal(lines.length, 3);
  assert.equal(
    lines[1],
    'r-fixed,平尾,"Daichi, ""test"" iPhone",smartphone,2026-09-11T12:43:27+09:00,1789098207123,kahaku,12,A',
  );
  assert.equal(
    lines[2],
    "r-fixed,平尾,beacon-21,beacon,2026-09-11T12:43:27+09:00,1789098207123,kahaku,12,A",
  );
});

test("未登録の施設・範囲外センサ・A/B以外・空の記録者やデバイスを拒否する", () => {
  const core = loadMuseumLoggerCore();
  const capturedAt = new Date("2026-09-11T03:43:27.123Z");
  const settings = sampleSettings();
  const create = (overrides, sensorNumber = 1, direction = "A") =>
    core.createPassageRecord(
      { ...settings, ...overrides },
      sensorNumber,
      direction,
      capturedAt,
      () => "r-fixed",
    );

  assert.throws(() => create({ facilityId: "unknown" }), /施設/);
  assert.throws(() => create({}, 21), /センサ/);
  assert.throws(() => create({}, 1, "C"), /方向/);
  assert.throws(() => create({ collector: "  " }), /記録者/);
  assert.throws(() => create({ devices: [] }), /デバイス/);
});
