# Dashcam Tools

This repo contains tools for extracting metadata data from supported Tesla Dashcam videos. This includes information such as vehicle speed, steering wheel angle, and self-driving state.

This information also appears in the Dashcam Viewer during playback on supported vehicle displays and the Tesla App.

## Dashcam SEI Explorer (Easiest)

**[Use the online SEI Explorer →](https://teslamotors.github.io/dashcam/sei_explorer.html)**

Just drag and drop your MP4 files to extract SEI metadata to CSV. Works entirely in your browser - your files never leave your computer.

## Files

* [`sei_explorer.html`](sei_explorer.html)
    * Web-based video player that displays SEI metadata alongside video playback.
* [`sei_extractor.html`](sei_extractor.html)
    * Web-based metadata extractor. Generates a CSV of the metadata from an MP4.
* [`sei_extractor.py`](sei_extractor.py)
    * Python-based metadata extractor. Command-line tool for extracting SEI data from MP4 files.
* [`dashcam-mp4.js`](dashcam-mp4.js)
    * Shared JavaScript library for MP4 parsing and SEI metadata extraction. Used by both web tools.
* [`dashcam.proto`](dashcam.proto)
    * The protobuf spec that is used to decode SEI data in the MP4 file(s).

## Troubleshooting

Not all Tesla-generated dashcam clips contain SEI data. Only clips recorded on Tesla firmware 2025.44.25 or later and HW3 or above contain SEI data. If car is parked, SEI data may not be present.

If no SEI metadata is found, ensure your dashcam footage meets these requirements.
