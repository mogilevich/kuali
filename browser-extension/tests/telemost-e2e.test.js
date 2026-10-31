import assert from "node:assert/strict";
import test from "node:test";
import { parseDevToolsActivePort, quadCentre } from "../e2e/cdp.mjs";
import {
  PHRASES,
  activeSpeakerNames,
  createCloseWatcher,
  kualiConfigPath,
  muteWindow,
  nextSpeechStart,
  participantLeft,
  pcm16Wav,
  readPcm16Wav,
  trimSilence,
  voiceSchedule,
  whisperLanguage,
  withWhisperLanguage,
  wsAccept,
  wsFrame,
} from "../e2e/run-telemost-e2e.mjs";

test("the Telemost E2E reads and patches only [whisper] language", () => {
  const toml = '[application]\nlanguage = "en"\n\n[whisper]\nmodel = "large-v3-turbo-q5"\nlanguage = "es" # comment\n';
  assert.equal(whisperLanguage(toml), "es");
  assert.equal(whisperLanguage('[application]\nlanguage = "en"\n'), null);
  const patched = withWhisperLanguage(toml, "ru");
  assert.equal(whisperLanguage(patched), "ru");
  assert.match(patched, /\[application\]\nlanguage = "en"/);
  assert.match(patched, /language = "ru" # comment/);
  assert.equal(whisperLanguage(withWhisperLanguage("[whisper]\ngpu = true\n", "ru")), "ru");
  assert.equal(whisperLanguage(withWhisperLanguage('[llm]\nprovider = "x"', "ru")), "ru");
  assert.equal(
    kualiConfigPath("darwin", {}, "/Users/me"),
    "/Users/me/Library/Application Support/com.onwev.Kuali/config.toml",
  );
  assert.equal(kualiConfigPath("linux", {}, "/home/me"), "/home/me/.config/kuali/config.toml");
});

test("voices take disjoint slots of one wall-clock cycle", () => {
  const schedule = voiceSchedule({ a: 4_062, b: 3_511, recorder: 3_463 }, 1_000_000);
  assert.equal(schedule.slotMs, 7_600);
  assert.equal(schedule.cycleMs, 22_800);
  assert.deepEqual(schedule.offsets, { a: 0, b: 7_600, recorder: 15_200 });
  for (const role of ["a", "b"]) {
    assert(schedule.offsets[role] + schedule.speechMs[role] + 3_500 <= schedule.offsets[role] + schedule.slotMs);
  }
  assert.equal(nextSpeechStart(schedule, "b", 1_000_000), 1_007_600);
  assert.equal(nextSpeechStart(schedule, "b", 1_007_601), 1_030_400);
  assert.equal(nextSpeechStart(schedule, "a", 900_000), 1_000_000);
});

test("expected terms never open their phrase", () => {
  for (const { text, term } of Object.values(PHRASES)) {
    const position = text.toLowerCase().indexOf(term);
    assert(position > 0, `${term} must appear after the first word of «${text}»`);
  }
});

test("trimmed speech keeps its sample rate and loses the silence", () => {
  const sampleRate = 1_000;
  const pcm = Buffer.alloc(3_000 * 2);
  for (let index = 1_000; index < 1_500; index += 1) pcm.writeInt16LE(index % 2 ? 8_000 : -8_000, index * 2);
  const wav = readPcm16Wav(pcm16Wav(pcm, sampleRate));
  assert.equal(wav.sampleRate, sampleRate);
  const speech = trimSilence(wav.pcm, sampleRate, { padMs: 10 });
  assert.equal(speech.length / 2, 500 + 2 * 10);
  assert.throws(() => trimSilence(Buffer.alloc(100), sampleRate), /no contiene voz/);
});

test("mute windows tolerate slack and need speech before and after", () => {
  const seconds = [100, 101, 103, 104, 125, 140, 141];
  const window = muteWindow(seconds, 105_000, 130_000, { slackMs: 2_000, contextMs: 20_000 });
  assert.deepEqual(window.inside, [125]);
  assert.equal(window.before, 4);
  assert.equal(window.after, 2);
  assert.deepEqual(muteWindow([106, 128], 105_000, 130_000).inside, []);
});

test("a departure is found by channel, id, name or an updated roster", () => {
  const timeline = [
    { tsMs: 1_000, kind: "participant-left", channel: 4 },
    { tsMs: 5_000, kind: "participant-upsert", channel: 4, displayName: "Борис Тестовый" },
    { tsMs: 6_000, kind: "roster-state", participants: [{ displayName: "Анна Тестовая" }] },
    { tsMs: 7_000, kind: "participant-left", participantId: "p-b" },
  ];
  const search = { channels: [4], participantIds: ["p-b"], name: "Борис Тестовый" };
  assert.equal(participantLeft(timeline, { ...search, sinceMs: 2_000 }).kind, "roster-state");
  assert.equal(participantLeft(timeline, { ...search, sinceMs: 6_500 }).participantId, "p-b");
  assert.equal(participantLeft(timeline, { ...search, sinceMs: 8_000 }), null);
  assert.deepEqual(activeSpeakerNames([
    { kind: "active-speakers", participants: [{ displayName: "Анна Тестовая" }] },
    { kind: "active-speakers", participants: [] },
  ]), ["Анна Тестовая"]);
});

test("the health shim speaks minimal RFC 6455", () => {
  assert.equal(wsAccept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  assert.deepEqual([...wsFrame(0x8, Buffer.from([0x03, 0xe8]))], [0x88, 2, 0x03, 0xe8]);
  const long = wsFrame(0x1, Buffer.alloc(300));
  assert.deepEqual([...long.subarray(0, 4)], [0x81, 126, 1, 44]);
});

test("the shim spots the extension's Close frame across chunk boundaries", () => {
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = (opcode, payload) => {
    let head;
    if (payload.length < 126) head = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    else if (payload.length < 65_536) head = Buffer.from([0x80 | opcode, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
    else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | opcode;
      head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    return Buffer.concat([head, mask, Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]))]);
  };
  const stream = Buffer.concat([
    masked(0x2, Buffer.alloc(300, 7)),
    masked(0x1, Buffer.from('{"kind":"keepalive"}')),
    masked(0x8, Buffer.from([0x03, 0xe8, 0x6f, 0x6b])),
  ]);
  for (const size of [1, 3, 7, 64, stream.length]) {
    const codes = [];
    const watch = createCloseWatcher((code) => codes.push(code));
    for (let offset = 0; offset < stream.length; offset += size) watch(stream.subarray(offset, offset + size));
    assert.deepEqual(codes, [1000], `chunks of ${size}`);
  }
  const later = [];
  const watch = createCloseWatcher((code) => later.push(code));
  watch(masked(0x2, Buffer.alloc(70_000)));
  assert.deepEqual(later, []);
  watch(masked(0x8, Buffer.alloc(0)));
  assert.deepEqual(later, [null]);
});

test("CDP helpers parse DevToolsActivePort and quads", () => {
  assert.deepEqual(parseDevToolsActivePort("54975\n/devtools/browser/abc\n"), { port: 54975, path: "/devtools/browser/abc" });
  assert.equal(parseDevToolsActivePort("0\n/devtools/browser/abc"), null);
  assert.equal(parseDevToolsActivePort("9222\n"), null);
  assert.deepEqual(quadCentre([10, 20, 30, 20, 30, 40, 10, 40]), { x: 20, y: 30 });
});
