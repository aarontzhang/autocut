# Autocut — Feature Roadmap

## High Priority

- [ ] **Background audio track** — add audio-only tracks for music/SFX below the video track; per-track volume & mute; mixed in export via FFmpeg `amix`
  - Track data model (`Track` type, `trackId` on clips)
  - Timeline UI: multi-row rendering, track headers (name, mute, lock)
  - Playback: hidden `<audio>` elements for audio tracks
  - Export: render audio tracks + mix with video audio
  - Media panel: import audio files (MP3, WAV, AAC, OGG)
  - Migration: old projects auto-get default video track
  - **No** audio detach, no moving clips between tracks, no transcript/AI changes
- [ ] **Visual effects** — blur, sharpen, vignette, glitch, etc.
- [ ] **Audio effects** — EQ, noise reduction, compression
- [ ] **More transition types** — crossfade/dissolve, wipe, slide, zoom, dip-to-white
- [ ] **Copy/paste & duplicate clips** — clipboard operations on timeline

## Medium Priority

- [ ] **Export settings** — resolution, bitrate, format (WebM, MOV, GIF, audio-only)
- [ ] **Canvas size / aspect ratio** — 16:9, 9:16, 1:1, 4:5, custom
- [ ] **Manual color correction** — brightness, contrast, saturation, exposure, temperature sliders
- [ ] **Crop, pan & zoom (Ken Burns)** — animate position/scale within a clip
- [ ] **Reverse clip playback** — play a clip in reverse
- [ ] **Freeze frame** — hold on a single frame
- [ ] **Video rotation & flip** — rotate 90/180/270, mirror horizontal/vertical
- [ ] **Keyframe animation** — animate position, scale, opacity over time
- [ ] **Full-screen preview** — native resolution playback
- [ ] **Clip properties / inspector panel** — dedicated panel for selected clip properties
- [ ] **Ripple editing** — ripple delete, ripple trim modes

## Lower Priority

- [ ] **Animated text / text templates** — entrance/exit animations, style presets
- [ ] **Social media export presets** — one-click YouTube, TikTok, Instagram Reels
- [ ] **Green screen / chroma key**
- [ ] **Stickers, shapes, emojis** — graphic overlay library
- [ ] **Thumbnail generator** — pick frame, customize as thumbnail
- [ ] **Project templates** — starter layouts for common formats
- [ ] **Video stabilization** — post-capture stabilization
- [ ] **Auto-reframe** — AI-driven smart crop for different aspect ratios
- [ ] **Motion tracking** — track objects for text/graphic follow
- [ ] **Beat sync** — snap cuts to music beats
- [ ] **Speed ramping** — variable speed curves within a clip
- [ ] **Collaboration** — shared projects, real-time or async
