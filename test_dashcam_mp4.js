const assert = require('node:assert/strict');

global.window = {};
require('./dashcam-mp4.js');

const DashcamMP4 = global.window.DashcamMP4;

function parser(bytes = new Uint8Array(64)) {
    return new DashcamMP4(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

{
    const p = parser(Uint8Array.from([0x01, 0x02, 0x03, 0x04]));
    assert.equal(p.readNalLength(0, 1), 1);
    assert.equal(p.readNalLength(0, 2), 0x0102);
    assert.equal(p.readNalLength(0, 4), 0x01020304);
    assert.equal(p.nalType(0x06, 'avc'), 6);
    assert.equal(p.nalType(39 << 1, 'hevc'), 39);
}

{
    const fakeProto = { decode: bytes => Array.from(bytes) };
    const p = parser();

    const h264 = Uint8Array.from([0x06, 0x05, 0x04, 0x42, 0x42, 0x69, 0x10, 0x20, 0x80]);
    assert.deepEqual(p.decodeSei(h264, fakeProto, 'avc'), [0x10, 0x20]);

    const h265 = Uint8Array.from([39 << 1, 0x01, 0x05, 0x04, 0x42, 0x42, 0x69, 0x30, 0x40, 0x80]);
    assert.deepEqual(p.decodeSei(h265, fakeProto, 'hevc'), [0x30, 0x40]);
}

{
    const bytes = new Uint8Array(32);
    const view = new DataView(bytes.buffer);
    view.setUint8(1, 0x01); // general_profile_idc = 1 (Main)
    view.setUint32(2, 0x60000000); // reversed compatibility flags -> 0x6
    view.setUint8(6, 0xB0);
    view.setUint8(12, 93);
    const p = parser(bytes);
    assert.equal(p.hevcCodecString('hvc1', 0), 'hvc1.1.6.L93.B0');
}

{
    const bytes = new Uint8Array(32);
    const view = new DataView(bytes.buffer);
    view.setUint8(1, 0x01);
    view.setUint32(2, 0x60000000);
    view.setUint8(12, 93);
    const p = parser(bytes);
    assert.equal(p.hevcCodecString('hvc1', 0), 'hvc1.1.6.L93.00');

    view.setUint8(6, 0xB0);
    view.setUint8(7, 0x01);
    const pWithConstraints = parser(bytes);
    assert.equal(pWithConstraints.hevcCodecString('hvc1', 0), 'hvc1.1.6.L93.B0.01');
}


function mp4Box(type, payload) {
    const out = Buffer.alloc(8 + payload.length);
    out.writeUInt32BE(out.length, 0);
    out.write(type, 4, 4, 'ascii');
    Buffer.from(payload).copy(out, 8);
    return out;
}

function h265ConfigMp4(mdatPayload = Buffer.alloc(0)) {
    const hvcc = Buffer.alloc(23);
    hvcc[0] = 1;
    hvcc[1] = 1; // Main profile
    hvcc.writeUInt32BE(0x60000000, 2);
    hvcc[6] = 0xB0;
    hvcc[12] = 93;
    hvcc[21] = 0xFD; // two-byte NAL length fields
    hvcc[22] = 0; // no parameter arrays needed for this config parser test

    const visual = Buffer.alloc(78);
    visual.writeUInt16BE(1920, 24);
    visual.writeUInt16BE(1080, 26);
    const sample = mp4Box('hvc1', Buffer.concat([visual, mp4Box('hvcC', hvcc)]));

    const stsdHeader = Buffer.alloc(8);
    stsdHeader.writeUInt32BE(1, 4);
    const stsd = mp4Box('stsd', Buffer.concat([stsdHeader, sample]));

    const sttsPayload = Buffer.alloc(16);
    sttsPayload.writeUInt32BE(1, 4);
    sttsPayload.writeUInt32BE(1, 8);
    sttsPayload.writeUInt32BE(1000, 12);
    const stts = mp4Box('stts', sttsPayload);

    const mdhdPayload = Buffer.alloc(16);
    mdhdPayload.writeUInt32BE(1000, 12);
    const mdhd = mp4Box('mdhd', mdhdPayload);

    const stbl = mp4Box('stbl', Buffer.concat([stsd, stts]));
    const minf = mp4Box('minf', stbl);
    const mdia = mp4Box('mdia', Buffer.concat([mdhd, minf]));
    const trak = mp4Box('trak', mdia);
    return Buffer.concat([mp4Box('moov', trak), mp4Box('mdat', mdatPayload)]);
}

{
    const file = h265ConfigMp4();
    const p = parser(new Uint8Array(file));
    const config = p.getConfig();
    assert.equal(config.codecFamily, 'hevc');
    assert.equal(config.nalLengthSize, 2);
    assert.equal(config.width, 1920);
    assert.equal(config.height, 1080);
    assert.equal(config.codec, 'hvc1.1.6.L93.B0');
}

{
    const h265Sei = Buffer.from([39 << 1, 0x01, 0x05, 0x05, 0x42, 0x42, 0x69, 0x30, 0x40, 0x80]);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(h265Sei.length);
    const file = h265ConfigMp4(Buffer.concat([length, h265Sei]));
    const p = parser(new Uint8Array(file));
    const fakeProto = { decode: bytes => Array.from(bytes) };
    assert.deepEqual(p.extractSeiMessages(fakeProto), [[0x30, 0x40]]);
}

{
    const nal = (...bytes) => Buffer.from(bytes);
    const lengthPrefixed = (...nals) => Buffer.concat(nals.flatMap(n => {
        const length = Buffer.alloc(2);
        length.writeUInt16BE(n.length);
        return [length, n];
    }));
    const keyFirst = nal(19 << 1, 0x01, 0x80, 0x11);
    const keyContinuation = nal(19 << 1, 0x01, 0x00, 0x22);
    const deltaFirst = nal(1 << 1, 0x01, 0x80, 0x33);
    const deltaContinuation = nal(1 << 1, 0x01, 0x00, 0x44);
    const file = h265ConfigMp4(lengthPrefixed(
        keyFirst, keyContinuation, deltaFirst, deltaContinuation));
    const p = parser(new Uint8Array(file));
    const frames = p.parseFrames({ decode: () => null });
    assert.equal(frames.length, 2);
    assert.equal(frames[0].keyframe, true);
    assert.equal(frames[1].keyframe, false);
    assert.equal(frames[0].nalUnits.length, 2);
    assert.equal(frames[1].nalUnits.length, 2);
}

console.log('dashcam-mp4 H.265 synthetic tests passed');
