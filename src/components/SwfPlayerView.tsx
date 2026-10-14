import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  SkipBack,
  SkipForward,
  Repeat,
  Maximize2,
  Minimize2,
  ZoomIn,
  Gauge,
  Volume2,
  VolumeX,
  Music,
  Archive,
  Download,
  Check,
  Move,
  Undo2,
  Film,
} from 'lucide-react';
import { SwfPlayer } from '../swf/player';
import { SwfFile } from '../swf/types';
import { downloadSwfAssetsZip } from '../swf/assetExporter';

interface SwfPlayerViewProps {
  swf: SwfFile;
  fileName: string;
}

export const SwfPlayerView: React.FC<SwfPlayerViewProps> = ({ swf, fileName }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<SwfPlayer | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [isLooping, setIsLooping] = useState(true);
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  const [zoomMode, setZoomMode] = useState<'fit' | '100%' | '150%' | '200%'>('fit');
  const [bgMode, setBgMode] = useState<'swf' | 'checkerboard' | 'dark' | 'light'>('swf');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fps, setFps] = useState(swf.frameRate || 12);
  const [isExporting, setIsExporting] = useState(false);
  const [exportSuccess, setExportSuccess] = useState(false);

  // Drag-and-drop asset state (active only when paused)
  const [hoveredAsset, setHoveredAsset] = useState<{ depth: number; characterId: number; name?: string } | null>(null);
  const [draggedAsset, setDraggedAsset] = useState<{ depth: number; characterId: number } | null>(null);
  const [isDraggingAsset, setIsDraggingAsset] = useState(false);
  const [hasModifiedPositions, setHasModifiedPositions] = useState(false);

  const handleResetPositions = () => {
    playerRef.current?.renderer.resetAssetPositions();
  };

  const handleDownloadZip = async () => {
    if (isExporting) return;
    try {
      setIsExporting(true);
      setExportSuccess(false);
      await downloadSwfAssetsZip(swf, fileName);
      setExportSuccess(true);
      setTimeout(() => setExportSuccess(false), 3000);
    } catch (e) {
      console.error('Failed to export SWF assets ZIP:', e);
    } finally {
      setIsExporting(false);
    }
  };

  // Audio states
  const [hasAudio, setHasAudio] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1.0);

  const stageWidth = Math.max(1, Math.round(swf.frameSize.width)) || 550;
  const stageHeight = Math.max(1, Math.round(swf.frameSize.height)) || 400;
  const totalFrames = Math.max(1, swf.frameCount);

  // Setup player when swf changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;

    // High DPI scaling for retina displays & crisp vectors
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = stageWidth * dpr;
    canvas.height = stageHeight * dpr;

    const player = new SwfPlayer(swf, canvas);
    playerRef.current = player;

    player.onFrameChange = (frame) => {
      if (!cancelled) setCurrentFrame(frame);
    };

    player.onPlayStateChange = (playing) => {
      if (!cancelled) setIsPlaying(playing);
    };

    player.onFpsUpdate = (currentFps) => {
      if (!cancelled) setFps(currentFps);
    };

    player.onAudioStatus = (exists) => {
      if (!cancelled) setHasAudio(exists);
    };

    player.renderer.onHoverAssetChange = (info) => {
      if (!cancelled) setHoveredAsset(info);
    };

    player.renderer.onDragStateChange = (dragging, info) => {
      if (!cancelled) {
        setIsDraggingAsset(dragging);
        setDraggedAsset(info);
      }
    };

    player.renderer.onPositionsModifiedChange = (modified) => {
      if (!cancelled) setHasModifiedPositions(modified);
    };

    setHasAudio(player.hasAudio);

    player.init().then(() => {
      if (!cancelled) {
        player.play();
      }
    });

    return () => {
      cancelled = true;
      player.destroy();
      if (playerRef.current === player) {
        playerRef.current = null;
      }
    };
  }, [swf, stageWidth, stageHeight]);

  // Update speed & loop
  useEffect(() => {
    if (playerRef.current) {
      playerRef.current.playbackSpeed = playbackSpeed;
      playerRef.current.isLooping = isLooping;
    }
  }, [playbackSpeed, isLooping]);

  const handleTogglePlay = () => {
    playerRef.current?.togglePlay();
  };

  const handleStepForward = () => {
    playerRef.current?.stepForward();
  };

  const handleStepBackward = () => {
    playerRef.current?.stepBackward();
  };

  const handleRestart = () => {
    playerRef.current?.restart();
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const target = parseInt(e.target.value, 10);
    playerRef.current?.seek(target, true);
  };

  const handleToggleMute = () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    playerRef.current?.toggleMute();
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    setIsMuted(v === 0);
    playerRef.current?.setVolume(v);
  };

  const handleToggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const getStageCoords = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * stageWidth;
      const y = ((e.clientY - rect.top) / rect.height) * stageHeight;
      return { x, y };
    },
    [stageWidth, stageHeight]
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = getStageCoords(e);
    playerRef.current?.renderer.handlePointerMove(x, y);
    playerRef.current?.renderer.handlePointerDown();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = getStageCoords(e);
    playerRef.current?.renderer.handlePointerMove(x, y);
  };

  const handlePointerUp = () => {
    playerRef.current?.renderer.handlePointerUp();
  };

  const currentSec = currentFrame / swf.frameRate;
  const totalSec = totalFrames / swf.frameRate;
  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 10);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms}`;
  };

  const getViewportDimensions = () => {
    if (zoomMode === '100%') {
      return {
        width: `${stageWidth}px`,
        height: `${stageHeight}px`,
        maxWidth: '100%',
        maxHeight: '100%',
      };
    }
    if (zoomMode === '150%') {
      return {
        width: `${stageWidth * 1.5}px`,
        height: `${stageHeight * 1.5}px`,
        maxWidth: '100%',
      };
    }
    if (zoomMode === '200%') {
      return {
        width: `${stageWidth * 2.0}px`,
        height: `${stageHeight * 2.0}px`,
      };
    }
    // 'fit': Fit to actual SWF dimensions without stretching or blowing out
    return {
      width: `${stageWidth}px`,
      height: `${stageHeight}px`,
      maxWidth: '100%',
      maxHeight: 'calc(100vh - 260px)',
      objectFit: 'contain' as const,
      aspectRatio: `${stageWidth} / ${stageHeight}`,
    };
  };

  const getBgStyle = () => {
    if (bgMode === 'swf') {
      return {
        backgroundColor: `rgb(${swf.backgroundColor.r}, ${swf.backgroundColor.g}, ${swf.backgroundColor.b})`,
      };
    }
    if (bgMode === 'checkerboard') {
      return {
        backgroundImage: `radial-gradient(#475569 0.75px, transparent 0.75px), radial-gradient(#475569 0.75px, #1e293b 0.75px)`,
        backgroundSize: '16px 16px',
        backgroundPosition: '0 0, 8px 8px',
      };
    }
    if (bgMode === 'light') {
      return { backgroundColor: '#ffffff' };
    }
    return { backgroundColor: '#090d16' };
  };

  return (
    <div
      ref={containerRef}
      className={`flex flex-col bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden ${
        isFullscreen ? 'p-0 w-screen h-screen rounded-none' : 'w-full'
      }`}
    >
      {/* Top Header Bar */}
      <div className="bg-slate-950/90 border-b border-slate-800 px-4 py-2.5 flex items-center justify-between gap-4 text-xs font-medium text-slate-300">
        <div className="flex items-center gap-2.5 truncate">
          <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse" />
          <span className="font-semibold text-white truncate max-w-xs">{fileName}</span>
          <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded text-[11px] font-mono">
            {stageWidth} × {stageHeight} px
          </span>
          <span className="bg-amber-950/70 text-amber-300 border border-amber-600/30 px-2 py-0.5 rounded text-[11px] font-mono">
            v{swf.version} {swf.signature}
          </span>
          {hasAudio && (
            <span className="bg-emerald-950 text-emerald-300 border border-emerald-500/40 px-2 py-0.5 rounded text-[11px] font-mono flex items-center gap-1">
              <Music className="w-3 h-3 text-emerald-400 animate-bounce" />
              <span>MP3 Audio Sync</span>
            </span>
          )}
          {swf.videoStreams && swf.videoStreams.size > 0 && (() => {
            const firstStream = Array.from(swf.videoStreams.values())[0];
            return (
              <span
                className="bg-rose-950 text-rose-300 border border-rose-500/40 px-2 py-0.5 rounded text-[11px] font-mono flex items-center gap-1.5"
                title={`${firstStream.codecName} (${firstStream.versionName || 'Video Stream'}) · ${firstStream.width}x${firstStream.height}px`}
              >
                <Film className="w-3 h-3 text-rose-400 shrink-0" />
                <span className="font-semibold">{firstStream.codecName}</span>
                {firstStream.versionName && (
                  <span className="text-[10px] text-amber-300/90 bg-black/40 px-1 py-0.5 rounded">
                    {firstStream.versionName}
                  </span>
                )}
              </span>
            );
          })()}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {/* Audio Controls */}
          {hasAudio && (
            <div className="flex items-center gap-1.5 bg-slate-900 px-2 py-1 rounded border border-slate-800">
              <button
                onClick={handleToggleMute}
                title={isMuted ? 'Unmute' : 'Mute'}
                className="text-slate-400 hover:text-white transition-colors"
              >
                {isMuted || volume === 0 ? (
                  <VolumeX className="w-3.5 h-3.5 text-rose-400" />
                ) : (
                  <Volume2 className="w-3.5 h-3.5 text-emerald-400" />
                )}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={isMuted ? 0 : volume}
                onChange={handleVolumeChange}
                className="w-14 sm:w-20 h-1.5 bg-slate-800 rounded appearance-none cursor-pointer accent-amber-500"
              />
            </div>
          )}

          {/* FPS Counter */}
          <div className="flex items-center gap-1.5 text-slate-400 font-mono bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
            <Gauge className="w-3.5 h-3.5 text-amber-400" />
            <span>
              <strong className="text-white">{fps}</strong> / {swf.frameRate} fps
            </span>
          </div>

          {/* Background Toggle */}
          <div className="hidden sm:flex items-center gap-1 bg-slate-900 p-0.5 rounded border border-slate-800">
            <button
              onClick={() => setBgMode('swf')}
              title="SWF Original Background"
              className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                bgMode === 'swf' ? 'bg-amber-500 text-slate-950 font-bold' : 'text-slate-400 hover:text-white'
              }`}
            >
              Stage BG
            </button>
            <button
              onClick={() => setBgMode('checkerboard')}
              title="Checkerboard Transparent"
              className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                bgMode === 'checkerboard' ? 'bg-amber-500 text-slate-950 font-bold' : 'text-slate-400 hover:text-white'
              }`}
            >
              Grid
            </button>
            <button
              onClick={() => setBgMode('dark')}
              title="Dark Background"
              className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                bgMode === 'dark' ? 'bg-amber-500 text-slate-950 font-bold' : 'text-slate-400 hover:text-white'
              }`}
            >
              Dark
            </button>
          </div>

          {/* Zoom Selector */}
          <div className="flex items-center gap-1 bg-slate-900 p-0.5 rounded border border-slate-800">
            <ZoomIn className="w-3 h-3 text-slate-400 ml-1" />
            {(['fit', '100%', '150%'] as const).map((z) => (
              <button
                key={z}
                onClick={() => setZoomMode(z)}
                className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-mono transition-colors ${
                  zoomMode === z ? 'bg-amber-500 text-slate-950 font-bold' : 'text-slate-400 hover:text-white'
                }`}
              >
                {z}
              </button>
            ))}
          </div>

          {/* Download SWF Assets as ZIP Button */}
          <button
            onClick={handleDownloadZip}
            disabled={isExporting}
            title="Download all extracted SWF assets as a ZIP file"
            className="flex items-center gap-1.5 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 active:scale-95 text-slate-950 px-2.5 py-1 rounded-lg text-xs font-bold transition-all shadow-md shadow-amber-500/20 shrink-0 cursor-pointer disabled:opacity-50"
          >
            {isExporting ? (
              <div className="w-3.5 h-3.5 border-2 border-slate-950 border-t-transparent rounded-full animate-spin" />
            ) : exportSuccess ? (
              <Check className="w-3.5 h-3.5 stroke-[3]" />
            ) : (
              <Archive className="w-3.5 h-3.5 fill-current" />
            )}
            <span className="hidden sm:inline">
              {isExporting ? 'Packing...' : exportSuccess ? 'Downloaded!' : 'Install Assets'}
            </span>
            <span className="text-[10px] font-mono uppercase bg-slate-950/20 px-1 py-0.5 rounded font-black">
              .zip
            </span>
          </button>

          {/* Fullscreen Toggle */}
          <button
            onClick={handleToggleFullscreen}
            title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
          >
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Paused Mode Asset Dragging Helper Bar */}
      {!isPlaying && (
        <div className="bg-slate-950/90 border-b border-amber-500/30 px-4 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="flex h-2 w-2 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
            </span>
            <div className="flex items-center gap-1.5 text-amber-300 font-medium">
              <Move className="w-3.5 h-3.5 text-amber-400" />
              <span>
                <strong>Paused Mode:</strong> Click &amp; drag any visual asset on stage to move it
              </span>
            </div>

            {isDraggingAsset && draggedAsset && (
              <span className="bg-amber-500/20 border border-amber-500/40 text-amber-200 px-2 py-0.5 rounded text-[11px] font-mono animate-pulse">
                Dragging Asset ID {draggedAsset.characterId} (Depth {draggedAsset.depth})
              </span>
            )}

            {!isDraggingAsset && hoveredAsset && (
              <span className="bg-sky-500/20 border border-sky-500/40 text-sky-200 px-2 py-0.5 rounded text-[11px] font-mono">
                Asset ID {hoveredAsset.characterId} (Depth {hoveredAsset.depth})
              </span>
            )}
          </div>

          {hasModifiedPositions && (
            <button
              onClick={handleResetPositions}
              className="flex items-center gap-1 text-[11px] bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-500/30 px-2.5 py-1 rounded-lg transition-all active:scale-95 cursor-pointer font-medium shadow-sm"
              title="Reset asset positions back to original frame layout"
            >
              <Undo2 className="w-3 h-3" />
              <span>Reset Layout</span>
            </button>
          )}
        </div>
      )}

      {/* Main Flash Canvas Viewport */}
      <div
        className="flex-1 min-h-[350px] max-h-[70vh] bg-slate-950 flex items-center justify-center p-3 overflow-auto relative select-none"
        style={getBgStyle()}
      >
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          style={getViewportDimensions()}
          className={`shadow-2xl rounded-sm touch-none transition-all ${
            isPlaying
              ? 'cursor-default'
              : isDraggingAsset
              ? 'cursor-grabbing'
              : hoveredAsset
              ? 'cursor-grab'
              : 'cursor-default'
          }`}
        />
      </div>

      {/* Playback Controls & Scrubber */}
      <div className="bg-slate-950 border-t border-slate-800 p-3 sm:p-4 text-slate-200">
        {/* Progress Bar & Frame Scrubber */}
        <div className="flex items-center gap-3 mb-3">
          <span className="text-xs font-mono text-slate-400 w-16 text-right">
            {formatTime(currentSec)}
          </span>

          <div className="flex-1 relative flex items-center">
            <input
              type="range"
              min={0}
              max={Math.max(0, totalFrames - 1)}
              value={currentFrame}
              onChange={handleSeek}
              className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-500 hover:accent-amber-400 transition-all focus:outline-none"
            />
          </div>

          <span className="text-xs font-mono text-slate-400 w-16">
            {formatTime(totalSec)}
          </span>
        </div>

        {/* Buttons Row */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Main Playback Buttons */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleRestart}
              title="Restart from Beginning"
              className="p-2 rounded-xl bg-slate-900 hover:bg-slate-800 active:scale-95 text-slate-300 hover:text-white transition-all border border-slate-800"
            >
              <RotateCcw className="w-4 h-4" />
            </button>

            <button
              onClick={handleStepBackward}
              title="Step 1 Frame Back"
              className="p-2 rounded-xl bg-slate-900 hover:bg-slate-800 active:scale-95 text-slate-300 hover:text-white transition-all border border-slate-800"
            >
              <SkipBack className="w-4 h-4" />
            </button>

            <button
              onClick={handleTogglePlay}
              title={isPlaying ? 'Pause' : 'Play'}
              className="px-5 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-bold active:scale-95 transition-all shadow-lg flex items-center gap-2"
            >
              {isPlaying ? (
                <>
                  <Pause className="w-4 h-4 fill-current" />
                  <span className="text-xs uppercase tracking-wide">Pause</span>
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 fill-current" />
                  <span className="text-xs uppercase tracking-wide">Play</span>
                </>
              )}
            </button>

            <button
              onClick={handleStepForward}
              title="Step 1 Frame Forward"
              className="p-2 rounded-xl bg-slate-900 hover:bg-slate-800 active:scale-95 text-slate-300 hover:text-white transition-all border border-slate-800"
            >
              <SkipForward className="w-4 h-4" />
            </button>

            <button
              onClick={() => setIsLooping(!isLooping)}
              title={isLooping ? 'Looping enabled' : 'Looping disabled'}
              className={`p-2 rounded-xl border transition-all active:scale-95 ${
                isLooping
                  ? 'bg-amber-500/20 border-amber-500/50 text-amber-400'
                  : 'bg-slate-900 border-slate-800 text-slate-500 hover:text-slate-300'
              }`}
            >
              <Repeat className="w-4 h-4" />
            </button>
          </div>

          {/* Frame Indicator Pill */}
          <div className="flex items-center gap-2 bg-slate-900/90 border border-slate-800 px-3 py-1.5 rounded-xl font-mono text-xs text-slate-300">
            <span className="text-slate-400">Frame:</span>
            <span className="font-bold text-amber-400">{currentFrame + 1}</span>
            <span className="text-slate-600">/</span>
            <span>{totalFrames}</span>
          </div>

          {/* Speed Selector */}
          <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 p-1 rounded-xl text-xs">
            <span className="text-slate-400 text-[11px] px-1.5">Speed:</span>
            {([0.5, 1.0, 1.5, 2.0] as const).map((spd) => (
              <button
                key={spd}
                onClick={() => setPlaybackSpeed(spd)}
                className={`px-2 py-0.5 rounded-lg text-xs font-mono transition-colors ${
                  playbackSpeed === spd
                    ? 'bg-amber-500 text-slate-950 font-bold'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {spd}x
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
