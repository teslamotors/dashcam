/**
 * Tesla Dashcam Playlist
 * Manages multiple MP4 clips as a single virtual video.
 * Only loads one clip at a time for memory efficiency.
 */
class DashcamPlaylist {
    constructor() {
        this.clips = [];          // Array of { file, frameCount, startFrame, endFrame }
        this.totalFrames = 0;
        this.currentClipIndex = -1;
        this.currentMp4 = null;
        this.currentFrames = null;
        this.seiType = null;
        this._config = null;
    }

    /**
     * Initialize playlist from files
     * @param {File[]} files - Array of File objects (MP4s)
     * @param {object} seiType - Protobuf SeiMetadata type
     * @param {string} cameraFilter - Camera type to filter (e.g., 'front', 'back')
     */
    async init(files, seiType, cameraFilter = 'front') {
        this.seiType = seiType;
        this.clips = [];
        this.totalFrames = 0;
        this.currentClipIndex = -1;
        this.currentMp4 = null;
        this.currentFrames = null;
        this._config = null;

        // Filter and sort MP4 files by camera type and timestamp
        const mp4Files = files
            .filter(f => f.name.toLowerCase().endsWith('.mp4'))
            .filter(f => f.name.includes(`-${cameraFilter}.mp4`))
            .sort((a, b) => this._extractTimestamp(a.name) - this._extractTimestamp(b.name));

        if (mp4Files.length === 0) {
            throw new Error(`No ${cameraFilter} camera MP4 files found`);
        }

        // Scan each file to get frame counts (reads only moov box, ~20-50KB each)
        for (const file of mp4Files) {
            const frameCount = await DashcamMP4.getFrameCountFromFile(file);
            this.clips.push({
                file,
                frameCount,
                startFrame: this.totalFrames,
                endFrame: this.totalFrames + frameCount - 1
            });
            this.totalFrames += frameCount;
        }

        // Load the first clip to get config
        await this._loadClip(0);
        return this;
    }

    /**
     * Extract timestamp from filename for sorting
     * Format: 2025-11-10_15-29-13-front.mp4
     */
    _extractTimestamp(filename) {
        const match = filename.match(/(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/);
        if (!match) return 0;
        return new Date(match[1].replace(/_/g, 'T').replace(/-/g, (m, i) => i < 10 ? '-' : ':')).getTime();
    }

    /**
     * Load a specific clip into memory
     */
    async _loadClip(clipIndex) {
        if (clipIndex === this.currentClipIndex && this.currentMp4) {
            return; // Already loaded
        }

        const clip = this.clips[clipIndex];
        const buffer = await clip.file.arrayBuffer();

        // Release previous clip
        this.currentMp4 = null;
        this.currentFrames = null;

        // Load new clip
        this.currentMp4 = new DashcamMP4(buffer);
        this.currentFrames = this.currentMp4.parseFrames(this.seiType);
        this.currentClipIndex = clipIndex;

        // Cache config from first clip
        if (!this._config) {
            this._config = this.currentMp4.getConfig();
        }
    }

    /**
     * Find which clip contains a global frame index
     */
    _findClipForFrame(globalFrame) {
        for (let i = 0; i < this.clips.length; i++) {
            const clip = this.clips[i];
            if (globalFrame >= clip.startFrame && globalFrame <= clip.endFrame) {
                return { clipIndex: i, localFrame: globalFrame - clip.startFrame };
            }
        }
        return null;
    }

    /**
     * Get frame data for a global frame index
     * Loads the appropriate clip if needed
     */
    async getFrame(globalFrame) {
        const loc = this._findClipForFrame(globalFrame);
        if (!loc) return null;

        await this._loadClip(loc.clipIndex);
        const frame = this.currentFrames[loc.localFrame];

        return {
            ...frame,
            globalIndex: globalFrame,
            clipIndex: loc.clipIndex,
            clipName: this.clips[loc.clipIndex].file.name,
            isClipBoundary: loc.localFrame === 0 && loc.clipIndex > 0
        };
    }

    /**
     * Find the keyframe index at or before a global frame
     * Returns global frame index of the keyframe
     */
    async findKeyframeBefore(globalFrame) {
        const loc = this._findClipForFrame(globalFrame);
        if (!loc) return 0;

        await this._loadClip(loc.clipIndex);

        // Search backwards in current clip for keyframe
        for (let i = loc.localFrame; i >= 0; i--) {
            if (this.currentFrames[i].keyframe) {
                return this.clips[loc.clipIndex].startFrame + i;
            }
        }

        // No keyframe found in this clip, return first frame of clip
        // (which should be a keyframe in properly encoded video)
        return this.clips[loc.clipIndex].startFrame;
    }

    /**
     * Get frames from keyframe to target for decoding
     * All within the same clip (required for H.264 decoding)
     */
    async getFramesForDecode(globalFrame) {
        const loc = this._findClipForFrame(globalFrame);
        if (!loc) return [];

        await this._loadClip(loc.clipIndex);

        // Find keyframe in this clip
        let keyIdx = loc.localFrame;
        while (keyIdx > 0 && !this.currentFrames[keyIdx].keyframe) {
            keyIdx--;
        }

        // Return frames from keyframe to target
        const frames = [];
        for (let i = keyIdx; i <= loc.localFrame; i++) {
            frames.push({
                ...this.currentFrames[i],
                globalIndex: this.clips[loc.clipIndex].startFrame + i
            });
        }
        return frames;
    }

    /**
     * Get video configuration
     */
    getConfig() {
        return this._config;
    }

    /**
     * Get frame duration for a global frame index
     */
    getFrameDuration(globalFrame) {
        const loc = this._findClipForFrame(globalFrame);
        if (!loc) return 33;

        const clipConfig = this._config;
        return clipConfig?.durations?.[loc.localFrame] || 33;
    }

    /**
     * Get first keyframe in the playlist
     */
    async getFirstKeyframe() {
        await this._loadClip(0);
        for (let i = 0; i < this.currentFrames.length; i++) {
            if (this.currentFrames[i].keyframe) {
                return i;
            }
        }
        return 0;
    }

    /**
     * Get all SEI messages for CSV export
     */
    async getAllSeiMessages() {
        const messages = [];
        for (let i = 0; i < this.clips.length; i++) {
            await this._loadClip(i);
            for (const frame of this.currentFrames) {
                if (frame.sei) {
                    messages.push(frame.sei);
                }
            }
        }
        return messages;
    }

    /**
     * Get clip info for display
     */
    getClipInfo() {
        return {
            clipCount: this.clips.length,
            totalFrames: this.totalFrames,
            clipNames: this.clips.map(c => c.file.name)
        };
    }

    /**
     * Get progress info for a global frame
     */
    getProgressInfo(globalFrame) {
        const loc = this._findClipForFrame(globalFrame);
        if (!loc) return null;

        return {
            clipIndex: loc.clipIndex,
            clipName: this.clips[loc.clipIndex].file.name,
            localFrame: loc.localFrame,
            clipFrameCount: this.clips[loc.clipIndex].frameCount,
            globalFrame,
            totalFrames: this.totalFrames
        };
    }
}

window.DashcamPlaylist = DashcamPlaylist;
