/**
 * Tesla Dashcam MP4 Parser
 * Parses MP4 files and extracts SEI metadata from Tesla dashcam footage.
 */
class DashcamMP4 {
    constructor(buffer) {
        this.buffer = buffer;
        this.view = new DataView(buffer);
        this._config = null;
    }

    // -------------------------------------------------------------
    // MP4 Box Navigation
    // -------------------------------------------------------------

    /** Find a box by name within a range */
    findBox(start, end, name) {
        for (let pos = start; pos + 8 <= end;) {
            let size = this.view.getUint32(pos);
            const type = this.readAscii(pos + 4, 4);
            const headerSize = size === 1 ? 16 : 8;

            if (size === 1) {
                const high = this.view.getUint32(pos + 8);
                const low = this.view.getUint32(pos + 12);
                size = Number((BigInt(high) << 32n) | BigInt(low));
            } else if (size === 0) {
                size = end - pos;
            }

            if (type === name) {
                return { start: pos + headerSize, end: pos + size, size: size - headerSize };
            }
            pos += size;
        }
        throw new Error(`Box "${name}" not found`);
    }

    /** Find mdat box and return content location */
    findMdat() {
        const mdat = this.findBox(0, this.view.byteLength, 'mdat');
        return { offset: mdat.start, size: mdat.size };
    }

    // -------------------------------------------------------------
    // Video Configuration
    // -------------------------------------------------------------

    /** Get video configuration (lazy-loaded) */
    getConfig() {
        if (this._config) return this._config;

        const moov = this.findBox(0, this.view.byteLength, 'moov');
        const trak = this.findBox(moov.start, moov.end, 'trak');
        const mdia = this.findBox(trak.start, trak.end, 'mdia');
        const minf = this.findBox(mdia.start, mdia.end, 'minf');
        const stbl = this.findBox(minf.start, minf.end, 'stbl');
        const stsd = this.findBox(stbl.start, stbl.end, 'stsd');
        const avc1 = this.findBox(stsd.start + 8, stsd.end, 'avc1');
        const avcC = this.findBox(avc1.start + 78, avc1.end, 'avcC');

        const o = avcC.start;
        const codec = `avc1.${this.hex(this.view.getUint8(o + 1))}${this.hex(this.view.getUint8(o + 2))}${this.hex(this.view.getUint8(o + 3))}`;

        // Extract SPS/PPS
        let p = o + 6;
        const spsLen = this.view.getUint16(p);
        const sps = new Uint8Array(this.buffer.slice(p + 2, p + 2 + spsLen));
        p += 2 + spsLen + 1;
        const ppsLen = this.view.getUint16(p);
        const pps = new Uint8Array(this.buffer.slice(p + 2, p + 2 + ppsLen));

        // Get timescale from mdhd (ticks per second, used to convert stts deltas to ms)
        const mdhd = this.findBox(mdia.start, mdia.end, 'mdhd');
        const mdhdVersion = this.view.getUint8(mdhd.start);
        const timescale = mdhdVersion === 1
            ? this.view.getUint32(mdhd.start + 20)
            : this.view.getUint32(mdhd.start + 12);

        // Get frame durations from stts (delta ticks per frame -> converted to ms)
        const stts = this.findBox(stbl.start, stbl.end, 'stts');
        const entryCount = this.view.getUint32(stts.start + 4);
        const durations = [];
        let pos = stts.start + 8;
        for (let i = 0; i < entryCount; i++) {
            const count = this.view.getUint32(pos);
            const delta = this.view.getUint32(pos + 4);
            const ms = (delta / timescale) * 1000;
            for (let j = 0; j < count; j++) durations.push(ms);
            pos += 8;
        }

        this._config = {
            width: this.view.getUint16(avc1.start + 24),
            height: this.view.getUint16(avc1.start + 26),
            codec, sps, pps, timescale, durations
        };
        return this._config;
    }

    // -------------------------------------------------------------
    // Frame Parsing (for Video Playback)
    // -------------------------------------------------------------

    /** Parse video frames with SEI metadata */
    parseFrames(SeiMetadata) {
        const config = this.getConfig();
        const mdat = this.findMdat();
        const frames = [];
        let cursor = mdat.offset;
        const end = mdat.offset + mdat.size;
        let pendingSei = null, currentSps = config.sps, currentPps = config.pps;

        while (cursor + 4 <= end) {
            const len = this.view.getUint32(cursor);
            cursor += 4;
            if (len < 1 || cursor + len > this.view.byteLength) break;

            const type = this.view.getUint8(cursor) & 0x1F;
            const data = new Uint8Array(this.buffer.slice(cursor, cursor + len));

            if (type === 7) currentSps = data; // SPS
            else if (type === 8) currentPps = data; // PPS
            else if (type === 6) pendingSei = this.decodeSei(data, SeiMetadata); // SEI
            else if (type === 5 || type === 1) { // IDR or Slice
                frames.push({
                    index: frames.length,
                    keyframe: type === 5,
                    data,
                    sei: pendingSei,
                    sps: currentSps,
                    pps: currentPps
                });
                pendingSei = null;
            }
            cursor += len;
        }
        return frames;
    }

    // -------------------------------------------------------------
    // SEI Extraction
    // -------------------------------------------------------------

    /** Extract all SEI messages for CSV export */
    extractSeiMessages(SeiMetadata) {
        const mdat = this.findMdat();
        const messages = [];
        let cursor = mdat.offset;
        const end = mdat.offset + mdat.size;

        while (cursor + 4 <= end) {
            const nalSize = this.view.getUint32(cursor);
            cursor += 4;

            if (nalSize < 2 || cursor + nalSize > this.view.byteLength) {
                cursor += Math.max(nalSize, 0);
                continue;
            }

            // NAL type 6 = SEI, payload type 5 = user data unregistered
            if ((this.view.getUint8(cursor) & 0x1F) === 6 && this.view.getUint8(cursor + 1) === 5) {
                const sei = this.decodeSei(new Uint8Array(this.buffer.slice(cursor, cursor + nalSize)), SeiMetadata);
                if (sei) messages.push(sei);
            }
            cursor += nalSize;
        }
        return messages;
    }

    /** Decode SEI NAL unit to protobuf message */
    decodeSei(nal, SeiMetadata) {
        if (!SeiMetadata || nal.length < 4) return null;

        let i = 3;
        while (i < nal.length && nal[i] === 0x42) i++;
        if (i <= 3 || i + 1 >= nal.length || nal[i] !== 0x69) return null;

        try {
            return SeiMetadata.decode(this.stripEmulationBytes(nal.subarray(i + 1, nal.length - 1)));
        } catch {
            return null;
        }
    }

    /** Strip H.264 emulation prevention bytes */
    stripEmulationBytes(data) {
        const out = [];
        let zeros = 0;
        for (const byte of data) {
            if (zeros >= 2 && byte === 0x03) { zeros = 0; continue; }
            out.push(byte);
            zeros = byte === 0 ? zeros + 1 : 0;
        }
        return Uint8Array.from(out);
    }

    // -------------------------------------------------------------
    // Utilities
    // -------------------------------------------------------------

    readAscii(start, len) {
        let s = '';
        for (let i = 0; i < len; i++) s += String.fromCharCode(this.view.getUint8(start + i));
        return s;
    }

    hex(n) { return n.toString(16).padStart(2, '0'); }

    /** Concatenate Uint8Arrays */
    static concat(...arrays) {
        const result = new Uint8Array(arrays.reduce((sum, a) => sum + a.length, 0));
        let offset = 0;
        for (const arr of arrays) { result.set(arr, offset); offset += arr.length; }
        return result;
    }
}

window.DashcamMP4 = DashcamMP4;
