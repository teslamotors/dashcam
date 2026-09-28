#!/usr/bin/env python3
"""
Tesla Dashcam SEI extractor.

Quick start:
    pip install protobuf
    protoc --python_out=. dashcam.proto
    python sei_extractor.py path/to/dashcam-video.mp4
"""
import struct
import sys
from typing import Generator, Optional, Tuple

from google.protobuf.json_format import MessageToDict
from google.protobuf.message import DecodeError

import dashcam_pb2


def run():
    if len(sys.argv) != 2:
        print("Usage: python sei_extractor.py <dashcam-video.mp4>")
        sys.exit(1)
    path = sys.argv[1]
    if not path.lower().endswith(".mp4"):
        print("Error: input file must end with .mp4")
        sys.exit(1)
    main(path)


def main(path: str):
    """Main function to extract and print SEI metadata from the video file, in CSV format."""
    has_sei = False
    with open(path, "rb") as fp:
        codec, nal_length_size = find_video_config(fp)
        offset, size = find_mdat(fp)
        headers = [
            field.name for field in dashcam_pb2.SeiMetadata.DESCRIPTOR.fields]
        for meta in iter_sei_messages(fp, offset, size, codec, nal_length_size):
            if not has_sei:
                has_sei = True
                print(','.join(headers))
            row_dict = {header: '' for header in headers}
            for key, value in MessageToDict(meta, preserving_proto_field_name=True).items():
                row_dict[key] = value
            print(','.join(str(row_dict[h]) for h in headers))
    if not has_sei:
        print("No SEI metadata found. Requirements:")
        print("  * Tesla firmware 2025.44.25 or later")
        print("  * HW3 or above")
        print("  * If car is parked, SEI data may not be present")


def iter_sei_messages(fp, offset: int, size: int, codec: str = "h264",
                      nal_length_size: int = 4):
    """Yield parsed SeiMetadata messages from the MP4 file."""
    for nal in iter_nals(fp, offset, size, codec, nal_length_size):
        payload = extract_proto_payload(nal, codec)
        if not payload:
            continue
        meta = dashcam_pb2.SeiMetadata()
        try:
            meta.ParseFromString(payload)
        except DecodeError:
            continue
        yield meta


def extract_proto_payload(nal: bytes, codec: str = "h264") -> Optional[bytes]:
    """Extract Tesla's protobuf payload from an H.264 or H.265 SEI NAL unit."""
    header_size = 2 if codec == "h265" else 1
    if not isinstance(nal, bytes) or len(nal) < header_size + 4:
        return None
    if nal[header_size] != 5:  # user_data_unregistered
        return None

    marker_start = header_size + 2  # NAL header + payload type + payload size
    i = marker_start
    while i < len(nal) - 1 and nal[i] == 0x42:
        i += 1
    if i <= marker_start or i >= len(nal) - 1 or nal[i] != 0x69:
        return None
    return strip_emulation_prevention_bytes(nal[i + 1:-1])


def strip_emulation_prevention_bytes(data: bytes) -> bytes:
    """Remove emulation prevention bytes (0x03 following 0x00 0x00)."""
    stripped = bytearray()
    zero_count = 0
    for byte in data:
        if zero_count >= 2 and byte == 0x03:
            zero_count = 0
            continue
        stripped.append(byte)
        zero_count = 0 if byte != 0 else zero_count + 1
    return bytes(stripped)


def iter_nals(fp, offset: int, size: int, codec: str = "h264",
              nal_length_size: int = 4) -> Generator[bytes, None, None]:
    """Yield SEI user NAL units from the MP4 mdat atom."""
    if nal_length_size not in (1, 2, 3, 4):
        raise ValueError("NAL length size must be between 1 and 4 bytes")

    fp.seek(offset)
    consumed = 0
    while size == 0 or consumed < size:
        header = fp.read(nal_length_size)
        if len(header) < nal_length_size:
            break
        nal_size = int.from_bytes(header, "big")
        consumed += nal_length_size
        if nal_size < 1:
            continue

        nal = fp.read(nal_size)
        if len(nal) != nal_size:
            break
        consumed += nal_size

        if codec == "h265":
            if len(nal) < 3:
                continue
            nal_type = (nal[0] >> 1) & 0x3F
            payload_type = nal[2]
            if nal_type not in (39, 40) or payload_type != 5:
                continue
        else:
            if len(nal) < 2:
                continue
            nal_type = nal[0] & 0x1F
            payload_type = nal[1]
            if nal_type != 6 or payload_type != 5:
                continue

        yield nal


def _find_box(fp, start: int, end: int, name: bytes) -> Tuple[int, int]:
    """Return (payload_start, box_end) for a direct child MP4 box."""
    pos = start
    while pos + 8 <= end:
        fp.seek(pos)
        header = fp.read(8)
        if len(header) != 8:
            break
        size32, atom_type = struct.unpack(">I4s", header)
        header_size = 8
        if size32 == 1:
            large = fp.read(8)
            if len(large) != 8:
                break
            atom_size = struct.unpack(">Q", large)[0]
            header_size = 16
        elif size32 == 0:
            atom_size = end - pos
        else:
            atom_size = size32

        if atom_size < header_size or pos + atom_size > end:
            break
        box_end = pos + atom_size
        if atom_type == name:
            return pos + header_size, box_end
        if size32 == 0:
            break
        pos = box_end
    raise RuntimeError(f'MP4 box {name.decode("ascii", "replace")} not found')


def find_video_config(fp) -> Tuple[str, int]:
    """Return (codec, NAL length size) from avcC/hvcC in the first video sample entry."""
    current = fp.tell()
    try:
        fp.seek(0, 2)
        file_end = fp.tell()
        moov_start, moov_end = _find_box(fp, 0, file_end, b"moov")
        trak_start, trak_end = _find_box(fp, moov_start, moov_end, b"trak")
        mdia_start, mdia_end = _find_box(fp, trak_start, trak_end, b"mdia")
        minf_start, minf_end = _find_box(fp, mdia_start, mdia_end, b"minf")
        stbl_start, stbl_end = _find_box(fp, minf_start, minf_end, b"stbl")
        stsd_start, stsd_end = _find_box(fp, stbl_start, stbl_end, b"stsd")

        entry_start = stsd_start + 8  # FullBox header + entry_count
        try:
            sample_start, sample_end = _find_box(fp, entry_start, stsd_end, b"avc1")
            config_start, _ = _find_box(fp, sample_start + 78, sample_end, b"avcC")
            fp.seek(config_start + 4)
            return "h264", (fp.read(1)[0] & 0x03) + 1
        except RuntimeError:
            try:
                sample_start, sample_end = _find_box(fp, entry_start, stsd_end, b"hvc1")
            except RuntimeError:
                sample_start, sample_end = _find_box(fp, entry_start, stsd_end, b"hev1")
            config_start, _ = _find_box(fp, sample_start + 78, sample_end, b"hvcC")
            fp.seek(config_start + 21)
            return "h265", (fp.read(1)[0] & 0x03) + 1
    finally:
        fp.seek(current)


def find_mdat(fp) -> Tuple[int, int]:
    """Return (offset, size) for the first mdat atom."""
    fp.seek(0)
    while True:
        header = fp.read(8)
        if len(header) < 8:
            raise RuntimeError("mdat atom not found")
        size32, atom_type = struct.unpack(">I4s", header)
        if size32 == 1:
            large = fp.read(8)
            if len(large) != 8:
                raise RuntimeError("truncated extended atom size")
            atom_size = struct.unpack(">Q", large)[0]
            header_size = 16
        else:
            atom_size = size32 if size32 else 0
            header_size = 8
        if atom_type == b"mdat":
            payload_size = atom_size - header_size if atom_size else 0
            return fp.tell(), payload_size
        if atom_size < header_size:
            raise RuntimeError("invalid MP4 atom size")
        fp.seek(atom_size - header_size, 1)


if __name__ == "__main__":
    run()
