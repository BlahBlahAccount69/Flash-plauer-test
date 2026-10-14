import React, { useState, useRef, useEffect } from 'react';
import {
  FileText,
  Layers,
  Image as ImageIcon,
  Code2,
  Volume2,
  Info,
  Search,
  Filter,
  Download,
  ExternalLink,
  ChevronRight,
  Sparkles,
  Archive,
  Package,
  Check,
  Film,
  Play,
  Pause,
} from 'lucide-react';
import { SwfFile, SwfTagInfo, SwfVideoStream } from '../swf/types';
import { downloadSwfAssetsZip } from '../swf/assetExporter';
import { fixMojibake } from '../swf/stringUtils';
import { VideoDecoderEngine } from '../swf/videoDecoder';

const VideoStreamCard: React.FC<{ stream: SwfVideoStream }> = ({ stream }) => {
  const [currentFrame, setCurrentFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const totalFrames = stream.numFrames || stream.frames.size || 1;
  const currentFrameData = stream.frames.get(currentFrame);
  const effectiveVersionName = stream.versionName || currentFrameData?.versionName || 'Standard Video';
  const effectivePictureType = currentFrameData?.pictureType || (currentFrameData?.isKeyframe ? 'Keyframe' : 'Interframe');

  useEffect(() => {
    let isCancelled = false;
    const renderTargetFrame = async () => {
      const decodedCanvas = await VideoDecoderEngine.decodeFrame(stream, currentFrame);
      if (isCancelled || !canvasRef.current || !decodedCanvas) return;

      const targetCanvas = canvasRef.current;
      targetCanvas.width = decodedCanvas.width;
      targetCanvas.height = decodedCanvas.height;
      const ctx = targetCanvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
        ctx.drawImage(decodedCanvas, 0, 0);
      }
    };

    renderTargetFrame();
    return () => {
      isCancelled = true;
    };
  }, [stream, currentFrame]);

  // Video auto-preview playback
  useEffect(() => {
    if (!isPlaying || totalFrames <= 1) return;
    const interval = setInterval(() => {
      setCurrentFrame((prev) => (prev + 1) % totalFrames);
    }, 1000 / 24);
    return () => clearInterval(interval);
  }, [isPlaying, totalFrames]);

  const handleDownloadSnapshot = () => {
    if (!canvasRef.current) return;
    try {
      const url = canvasRef.current.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = `video_stream_${stream.id}_frame_${currentFrame + 1}.png`;
      a.click();
    } catch {
      // ignore
    }
  };

  return (
    <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 flex flex-col justify-between hover:border-slate-700 transition-colors">
      <div className="flex flex-col gap-1 mb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Film className="w-3.5 h-3.5 text-rose-400" />
            <span className="text-xs font-bold text-white font-mono">Stream #{stream.id}</span>
          </div>
          <span className="text-[10px] bg-rose-950 text-rose-300 border border-rose-500/30 px-2 py-0.5 rounded font-mono font-semibold">
            {stream.codecName}
          </span>
        </div>
        <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
          <span className="text-amber-400/90 font-medium truncate max-w-[170px]" title={effectiveVersionName}>
            {effectiveVersionName}
          </span>
          <span className="text-emerald-400 bg-emerald-950/60 border border-emerald-500/30 px-1.5 py-0.2 rounded text-[9px]">
            {effectivePictureType}
          </span>
        </div>
      </div>

      <div className="w-full h-40 bg-slate-900 rounded-lg overflow-hidden flex items-center justify-center p-2 mb-3 relative group">
        <canvas
          ref={canvasRef}
          className="max-w-full max-h-full object-contain shadow-md rounded"
        />

        <div className="absolute top-2 right-2 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {totalFrames > 1 && (
            <button
              onClick={() => setIsPlaying(!isPlaying)}
              title={isPlaying ? 'Pause Preview' : 'Play Preview'}
              className="p-1.5 bg-slate-950/85 hover:bg-slate-800 text-slate-200 rounded-md transition-colors"
            >
              {isPlaying ? <Pause className="w-3.5 h-3.5 text-rose-400" /> : <Play className="w-3.5 h-3.5" />}
            </button>
          )}
          <button
            onClick={handleDownloadSnapshot}
            title="Download Frame PNG"
            className="p-1.5 bg-slate-950/85 hover:bg-slate-800 text-slate-200 rounded-md transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
          <span>
            {stream.width} × {stream.height} px
          </span>
          <span className="text-rose-300">
            Frame {currentFrame + 1} / {totalFrames}
          </span>
        </div>

        {totalFrames > 1 && (
          <input
            type="range"
            min={0}
            max={totalFrames - 1}
            value={currentFrame}
            onChange={(e) => {
              setIsPlaying(false);
              setCurrentFrame(Number(e.target.value));
            }}
            className="w-full accent-rose-500 h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer"
          />
        )}
      </div>
    </div>
  );
};

interface SwfInspectorProps {
  swf: SwfFile;
  fileName?: string;
}

export const SwfInspector: React.FC<SwfInspectorProps> = ({ swf, fileName = 'movie.swf' }) => {
  const [activeTab, setActiveTab] = useState<'overview' | 'tags' | 'assets' | 'actions'>('overview');
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [tagSearch, setTagSearch] = useState<string>('');
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportSuccess, setExportSuccess] = useState<boolean>(false);

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

  const rawSizeKb = (swf.rawBytes.length / 1024).toFixed(1);
  const uncompressedKb = (swf.uncompressedLength / 1024).toFixed(1);
  const durationSec = (swf.frameCount / (swf.frameRate || 12)).toFixed(2);
  const bgHex = `#${((1 << 24) + (swf.backgroundColor.r << 16) + (swf.backgroundColor.g << 8) + swf.backgroundColor.b).toString(16).slice(1)}`;

  // Filter tags
  const filteredTags = swf.tags.filter((t) => {
    const matchesSearch =
      t.name.toLowerCase().includes(tagSearch.toLowerCase()) ||
      (t.summary && t.summary.toLowerCase().includes(tagSearch.toLowerCase())) ||
      t.code.toString().includes(tagSearch) ||
      (t.characterId !== undefined && t.characterId.toString().includes(tagSearch));

    if (!matchesSearch) return false;

    if (tagFilter === 'all') return true;
    if (tagFilter === 'videos') return t.code === 60 || t.code === 61;
    if (tagFilter === 'shapes') return t.code === 2 || t.code === 22 || t.code === 32 || t.code === 83;
    if (tagFilter === 'bitmaps') return t.code === 6 || t.code === 20 || t.code === 21 || t.code === 35 || t.code === 36 || t.code === 90;
    if (tagFilter === 'actions') return t.code === 12 || t.code === 59 || t.code === 82;
    if (tagFilter === 'display') return t.code === 4 || t.code === 5 || t.code === 26 || t.code === 28 || t.code === 70;
    if (tagFilter === 'sprites') return t.code === 39;
    if (tagFilter === 'sound') return t.code === 14 || t.code === 15 || t.code === 18 || t.code === 19 || t.code === 45;
    if (tagFilter === 'text') return t.code === 10 || t.code === 11 || t.code === 33 || t.code === 37 || t.code === 48 || t.code === 75;

    return true;
  });

  const bitmapsList = Array.from(swf.bitmaps.values());
  const shapesList = Array.from(swf.shapes.values());
  const videoStreamsList = Array.from(swf.videoStreams?.values() || []);
  const spritesList = Array.from(swf.sprites.values());
  const soundsList = Array.from(swf.sounds.values());
  const textsList = Array.from(swf.texts.values());
  const fontsList = Array.from(swf.fonts.values());

  // Collect all ActionScript actions from frames
  const allFrameActions: { frame: number; actions: any[] }[] = [];
  swf.mainFrames.forEach((frame, idx) => {
    if (frame.actions && frame.actions.length > 0) {
      allFrameActions.push({ frame: idx + 1, actions: frame.actions });
    }
  });

  return (
    <div className="w-full bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden text-slate-100">
      {/* Navigation Tabs */}
      <div className="bg-slate-950 border-b border-slate-800 px-4 flex items-center gap-1 overflow-x-auto">
        <button
          onClick={() => setActiveTab('overview')}
          className={`py-3 px-3.5 border-b-2 font-medium text-xs sm:text-sm flex items-center gap-2 transition-all whitespace-nowrap ${
            activeTab === 'overview'
              ? 'border-amber-400 text-amber-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Info className="w-4 h-4" />
          <span>SWF Header &amp; Metadata</span>
        </button>

        <button
          onClick={() => setActiveTab('tags')}
          className={`py-3 px-3.5 border-b-2 font-medium text-xs sm:text-sm flex items-center gap-2 transition-all whitespace-nowrap ${
            activeTab === 'tags'
              ? 'border-amber-400 text-amber-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Layers className="w-4 h-4" />
          <span>Tag Stream ({swf.tags.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('assets')}
          className={`py-3 px-3.5 border-b-2 font-medium text-xs sm:text-sm flex items-center gap-2 transition-all whitespace-nowrap ${
            activeTab === 'assets'
              ? 'border-amber-400 text-amber-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <ImageIcon className="w-4 h-4" />
          <span>Extracted Assets ({bitmapsList.length + shapesList.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('actions')}
          className={`py-3 px-3.5 border-b-2 font-medium text-xs sm:text-sm flex items-center gap-2 transition-all whitespace-nowrap ${
            activeTab === 'actions'
              ? 'border-amber-400 text-amber-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Code2 className="w-4 h-4" />
          <span>ActionScript Bytecode</span>
        </button>
      </div>

      <div className="p-4 sm:p-6">
        {/* OVERVIEW TAB */}
        {activeTab === 'overview' && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <div className="bg-slate-950/80 border border-slate-800 p-3.5 rounded-xl">
                <div className="text-[11px] uppercase tracking-wider text-slate-400 font-mono mb-1">
                  Signature
                </div>
                <div className="text-lg font-bold text-amber-400 font-mono">
                  {swf.signature}
                </div>
                <div className="text-[10px] text-slate-500">
                  {swf.signature === 'CWS' ? 'Zlib Compressed' : 'Uncompressed'}
                </div>
              </div>

              <div className="bg-slate-950/80 border border-slate-800 p-3.5 rounded-xl">
                <div className="text-[11px] uppercase tracking-wider text-slate-400 font-mono mb-1">
                  Flash Version
                </div>
                <div className="text-lg font-bold text-white font-mono">
                  v{swf.version}
                </div>
                <div className="text-[10px] text-slate-500">
                  Flash Player {swf.version}.0+
                </div>
              </div>

              <div className="bg-slate-950/80 border border-slate-800 p-3.5 rounded-xl">
                <div className="text-[11px] uppercase tracking-wider text-slate-400 font-mono mb-1">
                  Dimensions
                </div>
                <div className="text-lg font-bold text-white font-mono">
                  {Math.round(swf.frameSize.width)}×{Math.round(swf.frameSize.height)}
                </div>
                <div className="text-[10px] text-slate-500">
                  {swf.frameSize.xmax}×{swf.frameSize.ymax} twips
                </div>
              </div>

              <div className="bg-slate-950/80 border border-slate-800 p-3.5 rounded-xl">
                <div className="text-[11px] uppercase tracking-wider text-slate-400 font-mono mb-1">
                  Frame Rate
                </div>
                <div className="text-lg font-bold text-emerald-400 font-mono">
                  {swf.frameRate} fps
                </div>
                <div className="text-[10px] text-slate-500">
                  {(1000 / swf.frameRate).toFixed(1)}ms per frame
                </div>
              </div>

              <div className="bg-slate-950/80 border border-slate-800 p-3.5 rounded-xl">
                <div className="text-[11px] uppercase tracking-wider text-slate-400 font-mono mb-1">
                  Frame Count
                </div>
                <div className="text-lg font-bold text-white font-mono">
                  {swf.frameCount}
                </div>
                <div className="text-[10px] text-slate-500">
                  Duration: {durationSec}s
                </div>
              </div>

              <div className="bg-slate-950/80 border border-slate-800 p-3.5 rounded-xl">
                <div className="text-[11px] uppercase tracking-wider text-slate-400 font-mono mb-1">
                  File Size
                </div>
                <div className="text-lg font-bold text-white font-mono">
                  {rawSizeKb} KB
                </div>
                <div className="text-[10px] text-slate-500">
                  Raw / {uncompressedKb} KB exp
                </div>
              </div>
            </div>

            {/* Stage Configuration */}
            <div className="bg-slate-950/50 border border-slate-800 rounded-xl p-4">
              <h4 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-400" />
                <span>Stage Configuration</span>
              </h4>

              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 text-xs font-mono">
                <div className="flex items-center gap-3">
                  <span className="text-slate-400">Background Color:</span>
                  <div className="flex items-center gap-2">
                    <span
                      className="w-5 h-5 rounded border border-slate-700 shadow-sm"
                      style={{ backgroundColor: bgHex }}
                    />
                    <span className="text-slate-200">{bgHex.toUpperCase()}</span>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <span className="text-slate-400">Stage Twips:</span>
                  <span className="text-slate-200">
                    [{swf.frameSize.xmin}, {swf.frameSize.ymin}, {swf.frameSize.xmax}, {swf.frameSize.ymax}]
                  </span>
                </div>

                <div className="flex items-center gap-3">
                  <span className="text-slate-400">Main Timeline Frames:</span>
                  <span className="text-slate-200">{swf.mainFrames.length} parsed</span>
                </div>
              </div>
            </div>

            {/* Content Summary Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-3 flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-blue-500/20 text-blue-400 flex items-center justify-center font-bold">
                  {shapesList.length}
                </div>
                <div>
                  <div className="text-xs font-medium text-slate-200">Vector Shapes</div>
                  <div className="text-[10px] text-slate-500">DefineShape 1-4</div>
                </div>
              </div>

              <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-3 flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-purple-500/20 text-purple-400 flex items-center justify-center font-bold">
                  {bitmapsList.length}
                </div>
                <div>
                  <div className="text-xs font-medium text-slate-200">Bitmaps &amp; JPEGs</div>
                  <div className="text-[10px] text-slate-500">Embedded images</div>
                </div>
              </div>

              <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-3 flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold">
                  {spritesList.length}
                </div>
                <div>
                  <div className="text-xs font-medium text-slate-200">MovieClip Sprites</div>
                  <div className="text-[10px] text-slate-500">Sub-timelines</div>
                </div>
              </div>

              <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-3 flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center font-bold">
                  {allFrameActions.length}
                </div>
                <div>
                  <div className="text-xs font-medium text-slate-200">Action Frames</div>
                  <div className="text-[10px] text-slate-500">DoAction scripts</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAG STREAM TAB */}
        {activeTab === 'tags' && (
          <div className="space-y-4">
            {/* Filters & Search */}
            <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between">
              {/* Type Filter Buttons */}
              <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0">
                {(
                  [
                    { id: 'all', label: 'All Tags' },
                    { id: 'videos', label: 'Videos' },
                    { id: 'shapes', label: 'Shapes' },
                    { id: 'display', label: 'Display' },
                    { id: 'bitmaps', label: 'Bitmaps' },
                    { id: 'sprites', label: 'Sprites' },
                    { id: 'actions', label: 'Actions' },
                    { id: 'text', label: 'Text' },
                  ] as const
                ).map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setTagFilter(f.id)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                      tagFilter === f.id
                        ? 'bg-amber-500 text-slate-950 font-bold'
                        : 'bg-slate-950 border border-slate-800 text-slate-400 hover:text-white'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              {/* Search Bar */}
              <div className="relative w-full sm:w-64">
                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  placeholder="Filter tag or ID..."
                  value={tagSearch}
                  onChange={(e) => setTagSearch(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-amber-500"
                />
              </div>
            </div>

            {/* Tag List Table */}
            <div className="border border-slate-800 rounded-xl overflow-hidden max-h-[500px] overflow-y-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-950 text-slate-400 sticky top-0 border-b border-slate-800 select-none">
                  <tr>
                    <th className="py-2.5 px-3 w-16">#</th>
                    <th className="py-2.5 px-3 w-24">Tag ID</th>
                    <th className="py-2.5 px-3 w-44">Tag Name</th>
                    <th className="py-2.5 px-3 w-28">Byte Offset</th>
                    <th className="py-2.5 px-3 w-24">Length</th>
                    <th className="py-2.5 px-3">Decoded Content</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 bg-slate-900/50">
                  {filteredTags.map((tag, idx) => (
                    <tr
                      key={idx}
                      className="hover:bg-slate-800/60 transition-colors group"
                    >
                      <td className="py-2 px-3 text-slate-500">{idx + 1}</td>
                      <td className="py-2 px-3 text-amber-400 font-bold">{tag.code}</td>
                      <td className="py-2 px-3 text-slate-200">
                        <span className="font-semibold text-white">{tag.name}</span>
                      </td>
                      <td className="py-2 px-3 text-slate-400">
                        0x{tag.offset.toString(16).toUpperCase()}
                      </td>
                      <td className="py-2 px-3 text-slate-400">
                        {tag.length} B
                      </td>
                      <td className="py-2 px-3 text-slate-300 truncate max-w-xs">
                        {tag.summary || '—'}
                      </td>
                    </tr>
                  ))}
                  {filteredTags.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-slate-500">
                        No tags match the current filter.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* EXTRACTED ASSETS TAB */}
        {activeTab === 'assets' && (
          <div className="space-y-6">
            {/* Top Download All Assets Banner */}
            <div className="bg-gradient-to-r from-amber-500/15 via-amber-500/5 to-slate-950/80 border border-amber-500/30 rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-xl">
              <div>
                <div className="flex items-center gap-2">
                  <Package className="w-5 h-5 text-amber-400" />
                  <h3 className="text-base font-bold text-white">Download All Extracted Assets</h3>
                  <span className="text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded font-mono font-semibold">
                    ZIP Archive
                  </span>
                </div>
                <p className="text-xs text-slate-300 mt-1 max-w-xl">
                  Export all embedded PNG/JPEG images, audio tracks (.mp3/.wav), vector shapes (.svg), clean decoded texts, and font metadata into an organized ZIP package.
                </p>
                <div className="flex flex-wrap items-center gap-2 mt-2 text-[11px] font-mono text-slate-400">
                  <span className="text-amber-300 font-semibold">{bitmapsList.length} Images</span>
                  <span>•</span>
                  <span className="text-emerald-300 font-semibold">{soundsList.length + (swf.streamSound ? 1 : 0)} Audio</span>
                  <span>•</span>
                  <span className="text-blue-300 font-semibold">{shapesList.length} Vector Shapes</span>
                  <span>•</span>
                  <span className="text-purple-300 font-semibold">{textsList.length} Texts</span>
                </div>
              </div>

              <button
                onClick={handleDownloadZip}
                disabled={isExporting}
                className="px-4 py-2.5 bg-amber-500 hover:bg-amber-400 active:scale-95 text-slate-950 font-bold rounded-xl text-xs sm:text-sm flex items-center justify-center gap-2 shadow-lg shadow-amber-500/20 transition-all shrink-0 cursor-pointer disabled:opacity-50"
              >
                {isExporting ? (
                  <>
                    <div className="w-4 h-4 border-2 border-slate-950 border-t-transparent rounded-full animate-spin" />
                    <span>Packing ZIP Archive...</span>
                  </>
                ) : exportSuccess ? (
                  <>
                    <Check className="w-4 h-4 text-emerald-950 stroke-[3]" />
                    <span>Downloaded!</span>
                  </>
                ) : (
                  <>
                    <Archive className="w-4 h-4 fill-current" />
                    <span>Install All Assets (.zip)</span>
                  </>
                )}
              </button>
            </div>

            {/* Video Streams Section */}
            {videoStreamsList.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                  <Film className="w-4 h-4 text-rose-400" />
                  <span>Embedded Video Streams ({videoStreamsList.length})</span>
                </h4>

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                  {videoStreamsList.map((stream) => (
                    <VideoStreamCard key={stream.id} stream={stream} />
                  ))}
                </div>
              </div>
            )}

            {/* Bitmaps Section */}
            <div>
              <h4 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                <ImageIcon className="w-4 h-4 text-purple-400" />
                <span>Extracted Bitmaps &amp; JPEG Assets ({bitmapsList.length})</span>
              </h4>

              {bitmapsList.length === 0 ? (
                <div className="p-6 bg-slate-950/60 border border-slate-800 rounded-xl text-center text-slate-500 text-xs">
                  This SWF file uses pure vector drawings and contains no embedded raster bitmaps.
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                  {bitmapsList.map((bmp) => (
                    <div
                      key={bmp.id}
                      className="bg-slate-950 border border-slate-800 rounded-xl p-2.5 flex flex-col justify-between group hover:border-slate-700 transition-colors"
                    >
                      <div className="w-full h-32 bg-slate-900 rounded-lg overflow-hidden flex items-center justify-center p-2 mb-2">
                        {bmp.dataUrl ? (
                          <img
                            src={bmp.dataUrl}
                            alt={`Bitmap ${bmp.id}`}
                            className="max-w-full max-h-full object-contain"
                          />
                        ) : (
                          <div className="text-xs text-slate-500 font-mono">No Preview</div>
                        )}
                      </div>

                      <div className="flex items-center justify-between text-xs">
                        <div>
                          <div className="font-semibold text-white">ID {bmp.id}</div>
                          <div className="text-[10px] text-slate-400 font-mono">
                            {bmp.width}×{bmp.height} px • {bmp.format}
                          </div>
                        </div>

                        {bmp.dataUrl && (
                          <a
                            href={bmp.dataUrl}
                            download={`swf_asset_${bmp.id}.png`}
                            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors"
                            title="Download Image"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Extracted Audio Section */}
            {(swf.streamSound || soundsList.length > 0) && (
              <div>
                <h4 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                  <Volume2 className="w-4 h-4 text-emerald-400" />
                  <span>Extracted Audio &amp; Soundtracks</span>
                </h4>

                <div className="space-y-3">
                  {swf.streamSound && (
                    <div className="bg-slate-950 border border-emerald-500/40 rounded-xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-emerald-300 text-sm">Streaming Audio Track (MP3)</span>
                          <span className="text-[10px] bg-emerald-950 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 rounded font-mono">
                            {swf.streamSound.streamRate} Hz • {swf.streamSound.isStereo ? 'Stereo' : 'Mono'}
                          </span>
                        </div>
                        <div className="text-xs text-slate-400 font-mono mt-1">
                          Full animation soundtrack ({(swf.streamSound.allMp3Bytes.length / 1024).toFixed(1)} KB MP3 data)
                        </div>
                      </div>

                      <button
                        onClick={() => {
                          const blob = new Blob([swf.streamSound!.allMp3Bytes.buffer as ArrayBuffer], { type: 'audio/mp3' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = 'soundtrack.mp3';
                          document.body.appendChild(a);
                          a.click();
                          document.body.removeChild(a);
                          URL.revokeObjectURL(url);
                        }}
                        className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-bold rounded-xl text-xs flex items-center gap-1.5 transition-colors shrink-0"
                      >
                        <Download className="w-4 h-4" />
                        Download Soundtrack (.mp3)
                      </button>
                    </div>
                  )}

                  {soundsList.map((sound) => (
                    <div
                      key={sound.id}
                      className="bg-slate-950 border border-slate-800 rounded-xl p-3 flex items-center justify-between"
                    >
                      <div>
                        <div className="font-semibold text-white text-xs">Sound Clip ID {sound.id}</div>
                        <div className="text-[10px] text-slate-400 font-mono">
                          {sound.format === 2 ? 'MP3' : sound.format === 1 ? 'ADPCM' : 'PCM'} • {sound.rate} Hz • {sound.sampleCount} samples
                        </div>
                      </div>

                      {sound.format === 2 && sound.data.length > 2 && (
                        <button
                          onClick={() => {
                            const blob = new Blob([sound.data.buffer as ArrayBuffer], { type: 'audio/mp3' });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = `sound_${sound.id}.mp3`;
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            URL.revokeObjectURL(url);
                          }}
                          className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                          title="Download Sound Clip"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Vector Shapes Section */}
            <div>
              <h4 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                <Layers className="w-4 h-4 text-blue-400" />
                <span>Extracted Vector Shapes ({shapesList.length})</span>
              </h4>

              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                {shapesList.map((shape) => (
                  <div
                    key={shape.id}
                    className="bg-slate-950 border border-slate-800 rounded-xl p-3 flex flex-col justify-between"
                  >
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs font-bold text-white font-mono">Shape ID {shape.id}</span>
                        <span className="text-[10px] bg-blue-950 text-blue-300 border border-blue-500/30 px-1.5 py-0.5 rounded">
                          {Math.round(shape.bounds.width)}×{Math.round(shape.bounds.height)} px
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-400 space-y-0.5 font-mono">
                        <div>Fill Styles: {shape.fillStyles.length}</div>
                        <div>Line Styles: {shape.lineStyles.length}</div>
                        <div>Drawing Paths: {shape.paths.length}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Text & Fonts Section */}
            {(textsList.length > 0 || fontsList.length > 0) && (
              <div>
                <h4 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                  <FileText className="w-4 h-4 text-emerald-400" />
                  <span>Text Elements &amp; Fonts ({textsList.length} texts, {fontsList.length} fonts)</span>
                </h4>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {textsList.map((t) => (
                    <div
                      key={t.id}
                      className="bg-slate-950 border border-slate-800 rounded-xl p-3 flex flex-col justify-between"
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs font-bold text-white font-mono">Text ID {t.id}</span>
                        <span className="text-[10px] bg-emerald-950 text-emerald-300 border border-emerald-500/30 px-1.5 py-0.5 rounded font-mono">
                          {t.textRecords.length > 0 ? `${t.textRecords.length} record(s)` : 'EditText'}
                        </span>
                      </div>
                      {t.initialText && (
                        <div className="text-xs text-slate-300 font-sans italic bg-slate-900/60 p-2 rounded border border-slate-800/60 truncate select-all">
                          "{fixMojibake(t.initialText).trim()}"
                        </div>
                      )}
                    </div>
                  ))}

                  {fontsList.map((f) => (
                    <div
                      key={f.id}
                      className="bg-slate-950 border border-slate-800 rounded-xl p-3 flex flex-col justify-between"
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs font-bold text-white font-mono">Font ID {f.id}</span>
                        <span className="text-[10px] bg-purple-950 text-purple-300 border border-purple-500/30 px-1.5 py-0.5 rounded font-mono">
                          {f.codeTable ? `${f.codeTable.length} glyphs` : 'Vector Font'}
                        </span>
                      </div>
                      <div className="text-xs text-slate-300 font-mono">
                        {fixMojibake(f.name)} {f.isBold ? 'Bold ' : ''}{f.isItalic ? 'Italic' : ''}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ACTIONSCRIPT TAB */}
        {activeTab === 'actions' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold text-white flex items-center gap-2">
                <Code2 className="w-4 h-4 text-amber-400" />
                <span>Disassembled ActionScript Bytecodes</span>
              </h4>
              <span className="text-xs text-slate-400 font-mono">
                {allFrameActions.length} frame script(s) found
              </span>
            </div>

            {allFrameActions.length === 0 ? (
              <div className="p-8 bg-slate-950/60 border border-slate-800 rounded-xl text-center text-slate-400 text-xs">
                No DoAction bytecode tags found in this SWF (timeline contains pure visual animations).
              </div>
            ) : (
              <div className="space-y-3">
                {allFrameActions.map((item, idx) => (
                  <div
                    key={idx}
                    className="bg-slate-950 border border-slate-800 rounded-xl p-4 font-mono text-xs"
                  >
                    <div className="flex items-center gap-2 text-amber-400 font-semibold mb-2.5 pb-2 border-b border-slate-800/80">
                      <ChevronRight className="w-4 h-4" />
                      <span>Frame {item.frame} Script</span>
                    </div>

                    <div className="space-y-1.5 pl-6 border-l-2 border-slate-800">
                      {item.actions.map((act, actIdx) => (
                        <div key={actIdx} className="flex items-start gap-3">
                          <span className="text-slate-500 select-none">{actIdx + 1}</span>
                          <span className="text-emerald-400 font-bold">{act.name}</span>
                          {act.args && (
                            <span className="text-slate-300">
                              {typeof act.args === 'object'
                                ? JSON.stringify(act.args)
                                : String(act.args)}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
