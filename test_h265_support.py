import io
import struct
import sys
import types
import unittest

# The parser helpers under test do not require generated protobuf bindings.
sys.modules.setdefault("dashcam_pb2", types.ModuleType("dashcam_pb2"))

import sei_extractor


def box(name: bytes, payload: bytes) -> bytes:
    return struct.pack(">I4s", len(payload) + 8, name) + payload


def synthetic_mp4(sample_type: bytes, config_type: bytes, config_payload: bytes,
                  mdat_payload: bytes = b"") -> bytes:
    sample = box(sample_type, bytes(78) + box(config_type, config_payload))
    stsd = box(b"stsd", bytes(4) + struct.pack(">I", 1) + sample)
    stbl = box(b"stbl", stsd)
    minf = box(b"minf", stbl)
    mdia = box(b"mdia", minf)
    trak = box(b"trak", mdia)
    return box(b"moov", trak) + box(b"mdat", mdat_payload)


class H265SupportTests(unittest.TestCase):
    def test_find_h264_nal_length_size(self):
        avcc = bytearray(5)
        avcc[4] = 0xFF  # lengthSizeMinusOne = 3 -> four-byte lengths
        fp = io.BytesIO(synthetic_mp4(b"avc1", b"avcC", bytes(avcc)))
        self.assertEqual(sei_extractor.find_video_config(fp), ("h264", 4))

    def test_find_h265_nal_length_size(self):
        hvcc = bytearray(22)
        hvcc[21] = 0xFD  # lengthSizeMinusOne = 1 -> two-byte lengths
        fp = io.BytesIO(synthetic_mp4(b"hvc1", b"hvcC", bytes(hvcc)))
        self.assertEqual(sei_extractor.find_video_config(fp), ("h265", 2))

    def test_iter_nals_handles_h264_and_h265_headers(self):
        h264_sei = bytes([0x06, 0x05, 0x03, 0x42, 0x69, 0x01, 0x80])
        h265_sei = bytes([39 << 1, 0x01, 0x05, 0x03, 0x42, 0x69, 0x02, 0x80])
        other_h265 = bytes([1 << 1, 0x01, 0x00])

        h264_stream = struct.pack(">I", len(h264_sei)) + h264_sei
        self.assertEqual(
            list(sei_extractor.iter_nals(io.BytesIO(h264_stream), 0, len(h264_stream), "h264", 4)),
            [h264_sei],
        )

        h265_stream = (
            len(other_h265).to_bytes(2, "big") + other_h265
            + len(h265_sei).to_bytes(2, "big") + h265_sei
        )
        self.assertEqual(
            list(sei_extractor.iter_nals(io.BytesIO(h265_stream), 0, len(h265_stream), "h265", 2)),
            [h265_sei],
        )

    def test_extract_proto_payload_preserves_h264_and_h265(self):
        h264 = bytes([0x06, 0x05, 0x04, 0x42, 0x42, 0x69, 0x10, 0x20, 0x80])
        h265 = bytes([39 << 1, 0x01, 0x05, 0x04, 0x42, 0x42, 0x69, 0x30, 0x40, 0x80])
        self.assertEqual(sei_extractor.extract_proto_payload(h264, "h264"), b"\x10\x20")
        self.assertEqual(sei_extractor.extract_proto_payload(h265, "h265"), b"\x30\x40")

    def test_h265_mp4_config_to_decoded_message(self):
        hvcc = bytearray(22)
        hvcc[21] = 0xFD  # two-byte NAL lengths
        h265_sei = bytes([39 << 1, 0x01, 0x05, 0x05, 0x42, 0x42, 0x69, 0x30, 0x40, 0x80])
        mdat = len(h265_sei).to_bytes(2, "big") + h265_sei
        fp = io.BytesIO(synthetic_mp4(b"hvc1", b"hvcC", bytes(hvcc), mdat))

        codec, nal_length_size = sei_extractor.find_video_config(fp)
        offset, size = sei_extractor.find_mdat(fp)

        class FakeMetadata:
            def ParseFromString(self, payload):
                self.payload = payload

        original = getattr(sei_extractor.dashcam_pb2, "SeiMetadata", None)
        sei_extractor.dashcam_pb2.SeiMetadata = FakeMetadata
        try:
            messages = list(sei_extractor.iter_sei_messages(
                fp, offset, size, codec, nal_length_size))
        finally:
            if original is None:
                delattr(sei_extractor.dashcam_pb2, "SeiMetadata")
            else:
                sei_extractor.dashcam_pb2.SeiMetadata = original

        self.assertEqual(codec, "h265")
        self.assertEqual(nal_length_size, 2)
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0].payload, b"\x30\x40")


if __name__ == "__main__":
    unittest.main()
