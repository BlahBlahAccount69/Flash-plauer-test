/**
 * SWF Playback Controller, Web Audio Engine and ActionScript Runtime
 * Synchronizes animation frames with streaming audio (London Underground / Music Videos)
 */

import { SwfRenderer } from './renderer';
import { SwfFile, SwfSound } from './types';
import { VideoDecoderEngine } from './videoDecoder';

export interface ActionScriptLog {
  timestamp: string;
  frame: number;
  message: string;
  type: 'info' | 'trace' | 'warning';
}

export class SwfPlayer {
  public swf: SwfFile;
  public renderer: SwfRenderer;
  public currentFrame = 0;
  public isPlaying = false;
  public isLooping = true;
  public playbackSpeed = 1.0;
  public volume = 1.0;
  public isMuted = false;

  public actualFps = 0;
  public targetFps = 12;

  private animFrameId: number | null = null;
  private lastTime = 0;
  private accumulator = 0;
  private fpsLastTime = 0;
  private fpsFramesCount = 0;

  // Web Audio Context & Streaming Sound
  private audioCtx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private streamAudioBuffer: AudioBuffer | null = null;
  private streamAudioSource: AudioBufferSourceNode | null = null;
  private streamAudioStartTime = 0;
  public hasAudio = false;
  public isAudioLoaded = false;
  public isDestroyed = false;

  public logs: ActionScriptLog[] = [];
  public onFrameChange?: (frame: number) => void;
  public onPlayStateChange?: (playing: boolean) => void;
  public onFpsUpdate?: (fps: number) => void;
  public onLog?: (log: ActionScriptLog) => void;
  public onAudioStatus?: (hasAudio: boolean, isReady: boolean) => void;

  constructor(swf: SwfFile, canvas: HTMLCanvasElement) {
    this.swf = swf;
    this.renderer = new SwfRenderer(swf, canvas);
    this.targetFps = swf.frameRate || 12;
    this.renderer.activeButtonClicked = (buttonId) => {
      this.handleButtonClick(buttonId);
    };

    this.hasAudio = !!(
      (swf.streamSound && swf.streamSound.allMp3Bytes.length > 0) ||
      swf.sounds.size > 0
    );
  }

  public async init(): Promise<void> {
    if (this.isDestroyed) return;
    this.currentFrame = 0;
    this.renderer.reset();

    // Preload bitmap images so they are ready on frame 0
    await this.preloadBitmaps();

    // Initialize video streams for instantaneous start
    if (this.swf.videoStreams && this.swf.videoStreams.size > 0) {
      await VideoDecoderEngine.initStreams(this.swf.videoStreams);
    }

    this.renderer.setFrame(0);
    this.executeFrameActions(0);

    // Initialize Audio
    await this.initAudio();
  }

  private async preloadBitmaps(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const bitmap of this.swf.bitmaps.values()) {
      if (bitmap.canvasElement) continue;
      if (bitmap.imageElement && !bitmap.imageElement.complete) {
        promises.push(
          new Promise((resolve) => {
            const img = bitmap.imageElement;
            if (!img || img.complete) {
              return resolve();
            }
            const prevOnload = img.onload;
            img.onload = (e) => {
              if (typeof prevOnload === 'function') prevOnload.call(img, e);
              resolve();
            };
            img.onerror = () => resolve();
            setTimeout(resolve, 500);
          })
        );
      }
    }
    if (promises.length > 0) {
      await Promise.all(promises);
      this.renderer.render();
    }
  }

  private async initAudio(): Promise<void> {
    try {
      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtxClass) return;

      this.audioCtx = new AudioCtxClass();
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = this.isMuted ? 0 : this.volume;
      this.gainNode.connect(this.audioCtx.destination);

      // 1. Decode Streaming Audio (e.g. London Underground / Music videos)
      if (this.swf.streamSound && this.swf.streamSound.allMp3Bytes.length > 0) {
        try {
          const mp3Bytes = this.swf.streamSound.allMp3Bytes;
          const ab = (mp3Bytes.buffer as ArrayBuffer).slice(0) as ArrayBuffer;
          const decoded = await this.audioCtx.decodeAudioData(ab);
          this.streamAudioBuffer = decoded;
          this.swf.streamSound.audioBuffer = decoded;
          this.isAudioLoaded = true;
          this.hasAudio = true;
          this.onAudioStatus?.(true, true);
        } catch (e) {
          console.warn('Could not decode streaming MP3 audio:', e);
        }
      }

      // 2. Decode Event Sounds (DefineSound)
      for (const sound of this.swf.sounds.values()) {
        if (sound.format === 2 && sound.data.length > 2) {
          try {
            // Find MP3 sync word or skip 2-byte SeekSamples
            let start = 2;
            for (let i = 0; i < Math.min(16, sound.data.length - 1); i++) {
              if (sound.data[i] === 0xff && (sound.data[i + 1] & 0xe0) === 0xe0) {
                start = i;
                break;
              }
            }
            const mp3 = sound.data.subarray(start);
            const ab = (mp3.buffer as ArrayBuffer).slice(0) as ArrayBuffer;
            const decoded = await this.audioCtx.decodeAudioData(ab);
            sound.audioBuffer = decoded;
            this.hasAudio = true;
          } catch {
            // ignore non-decodable sound clip
          }
        }
      }
    } catch (err) {
      console.warn('AudioContext init error:', err);
    }
  }

  public play(): void {
    if (this.isDestroyed || this.isPlaying) return;
    this.isPlaying = true;
    this.renderer.isPaused = false;

    // Resume AudioContext if suspended (browser autoplay policy)
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }

    // Start streaming sound synchronized at current timeline position
    this.startStreamingAudio();

    this.lastTime = performance.now();
    this.accumulator = 0;
    this.fpsLastTime = performance.now();
    this.fpsFramesCount = 0;
    this.onPlayStateChange?.(true);
    this.loop();
  }

  public pause(): void {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    this.renderer.isPaused = true;

    // Stop streaming sound
    this.stopStreamingAudio();

    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    this.renderer.render();
    this.onPlayStateChange?.(false);
  }

  public togglePlay(): void {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  public seek(frameIndex: number, adjustAudio = true): void {
    const totalFrames = Math.max(1, this.swf.frameCount);
    const clamped = Math.max(0, Math.min(frameIndex, totalFrames - 1));
    this.currentFrame = clamped;
    this.renderer.setFrame(clamped);
    this.onFrameChange?.(clamped);

    // If streaming audio exists and user manually scrubbed, restart audio at this frame
    if (adjustAudio && this.isPlaying && this.streamAudioBuffer) {
      this.stopStreamingAudio();
      this.startStreamingAudio();
    }
  }

  public stepForward(): void {
    this.pause();
    const totalFrames = Math.max(1, this.swf.frameCount);
    const next = (this.currentFrame + 1) % totalFrames;
    this.seek(next, true);
  }

  public stepBackward(): void {
    this.pause();
    const totalFrames = Math.max(1, this.swf.frameCount);
    const prev = (this.currentFrame - 1 + totalFrames) % totalFrames;
    this.seek(prev, true);
  }

  public restart(): void {
    this.accumulator = 0;
    this.seek(0, true);
    if (!this.isPlaying) {
      this.play();
    }
  }

  public setVolume(val: number): void {
    this.volume = Math.max(0, Math.min(1, val));
    if (this.gainNode) {
      this.gainNode.gain.value = this.isMuted ? 0 : this.volume;
    }
  }

  public toggleMute(): void {
    this.isMuted = !this.isMuted;
    if (this.gainNode) {
      this.gainNode.gain.value = this.isMuted ? 0 : this.volume;
    }
  }

  private startStreamingAudio(): void {
    if (!this.audioCtx || !this.gainNode || !this.streamAudioBuffer) return;
    this.stopStreamingAudio();

    try {
      const source = this.audioCtx.createBufferSource();
      source.buffer = this.streamAudioBuffer;
      source.playbackRate.value = this.playbackSpeed;
      source.connect(this.gainNode);

      const offsetSec = this.currentFrame / this.targetFps;
      if (offsetSec < this.streamAudioBuffer.duration) {
        source.start(0, offsetSec);
        this.streamAudioStartTime = this.audioCtx.currentTime - offsetSec / this.playbackSpeed;
        this.streamAudioSource = source;
      }
    } catch (e) {
      console.warn('Error starting streaming audio:', e);
    }
  }

  private stopStreamingAudio(): void {
    if (this.streamAudioSource) {
      try {
        this.streamAudioSource.stop();
        this.streamAudioSource.disconnect();
      } catch {
        // ignore
      }
      this.streamAudioSource = null;
    }
  }

  private playSound(soundId: number): void {
    if (!this.audioCtx || !this.gainNode || this.isMuted) return;
    const sound = this.swf.sounds.get(soundId);
    if (!sound || !sound.audioBuffer) return;

    try {
      const src = this.audioCtx.createBufferSource();
      src.buffer = sound.audioBuffer;
      src.connect(this.gainNode);
      src.start(0);
    } catch (e) {
      console.warn('Could not play sound:', e);
    }
  }

  private loop = (): void => {
    if (this.isDestroyed || !this.isPlaying) return;

    const now = performance.now();
    const dt = (now - this.lastTime) / 1000.0;
    this.lastTime = now;

    // Track real FPS
    this.fpsFramesCount++;
    if (now - this.fpsLastTime >= 1000) {
      this.actualFps = Math.round((this.fpsFramesCount * 1000) / (now - this.fpsLastTime));
      this.onFpsUpdate?.(this.actualFps);
      this.fpsFramesCount = 0;
      this.fpsLastTime = now;
    }

    const frameDuration = 1.0 / (this.targetFps * this.playbackSpeed);
    this.accumulator += Math.min(dt, 0.2);

    while (this.accumulator >= frameDuration) {
      this.accumulator -= frameDuration;
      this.advanceFrame();
    }

    if (!this.isDestroyed && this.isPlaying) {
      this.animFrameId = requestAnimationFrame(this.loop);
    }
  };

  private advanceFrame(): void {
    if (this.isDestroyed) return;
    const totalFrames = Math.max(1, this.swf.frameCount);
    let nextFrame = this.currentFrame + 1;

    if (nextFrame >= totalFrames) {
      if (this.isLooping) {
        nextFrame = 0;
        // Re-sync streaming audio on loop
        if (this.streamAudioBuffer && this.isPlaying && !this.isDestroyed) {
          this.startStreamingAudio();
        }
      } else {
        this.pause();
        return;
      }
    }

    this.currentFrame = nextFrame;
    this.renderer.setFrame(nextFrame);
    this.onFrameChange?.(nextFrame);
    this.executeFrameActions(nextFrame);
  }

  private executeFrameActions(frameIndex: number): void {
    if (this.isDestroyed || frameIndex >= this.swf.mainFrames.length) return;
    const frame = this.swf.mainFrames[frameIndex];
    if (!frame) return;

    // Trigger any event sounds on this frame
    if (frame.startSounds && frame.startSounds.length > 0) {
      for (const soundId of frame.startSounds) {
        this.playSound(soundId);
      }
    }

    // Execute ActionScript
    if (frame.actions && frame.actions.length > 0) {
      for (const action of frame.actions) {
        this.addLog({
          timestamp: new Date().toLocaleTimeString(),
          frame: frameIndex + 1,
          message: `Action: ${action.name} (${JSON.stringify(action.args || {})})`,
          type: 'info',
        });

        if (action.code === 0x07) {
          // Stop
          this.pause();
        } else if (action.code === 0x06) {
          // Play
          this.play();
        } else if (action.code === 0x81 && action.args?.frame !== undefined) {
          // GotoFrame
          this.seek(action.args.frame, true);
        } else if (action.code === 0x26) {
          // Trace
          this.addLog({
            timestamp: new Date().toLocaleTimeString(),
            frame: frameIndex + 1,
            message: `trace: ${JSON.stringify(action.args || '')}`,
            type: 'trace',
          });
        }
      }
    }
  }

  private handleButtonClick(buttonId: number): void {
    const btn = this.swf.buttons.get(buttonId);
    if (!btn) return;
    if (btn.actions) {
      for (const a of btn.actions) {
        if (a.code === 0x07) this.pause();
        if (a.code === 0x06) this.play();
        if (a.code === 0x81 && a.args?.frame !== undefined) this.seek(a.args.frame, true);
      }
    }
  }

  public addLog(log: ActionScriptLog): void {
    this.logs.unshift(log);
    if (this.logs.length > 100) this.logs.pop();
    this.onLog?.(log);
  }

  public destroy(): void {
    this.isDestroyed = true;
    this.pause();
    this.stopStreamingAudio();
    this.onFrameChange = undefined;
    this.onPlayStateChange = undefined;
    this.onFpsUpdate = undefined;
    this.onLog = undefined;
    this.onAudioStatus = undefined;
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }
}
