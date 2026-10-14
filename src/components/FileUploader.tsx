import React, { useRef, useState, useEffect } from 'react';
import {
  Upload,
  FileCode,
  Play,
  Sparkles,
  Download,
  CheckCircle2,
  HelpCircle,
  Link as LinkIcon,
  ShieldCheck,
  Smartphone,
  Video,
  Film,
} from 'lucide-react';
import { buildSampleSwf, buildSampleAvi } from '../swf/swfWriter';
import { VideoContainerParser } from '../swf/videoContainerParser';

interface FileUploaderProps {
  onLoadSwf: (bytes: Uint8Array, fileName: string) => void;
  isLoading: boolean;
  activeFileName?: string;
}

export const FileUploader: React.FC<FileUploaderProps> = ({
  onLoadSwf,
  isLoading,
  activeFileName,
}) => {
  // Input with no accept restriction (fixes iPad / iOS greyed out files bug)
  const iosInputRef = useRef<HTMLInputElement>(null);
  // Input with broader video + swf support
  const strictInputRef = useRef<HTMLInputElement>(null);

  const [dragActive, setDragActive] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);

  // Automatically detect iOS / iPadOS
  const [isIOSDevice, setIsIOSDevice] = useState(false);
  // If true, removes accept attribute so iPad Files app does not grey out files
  const [useIosPickerFix, setUseIosPickerFix] = useState(true);

  useEffect(() => {
    const isAppleMobile =
      typeof navigator !== 'undefined' &&
      (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
    setIsIOSDevice(isAppleMobile);
    if (isAppleMobile) {
      setUseIosPickerFix(true);
    }
  }, []);

  const processFile = (file: File) => {
    setErrorMsg(null);
    setSuccessMsg(null);

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const buffer = e.target?.result as ArrayBuffer;
        if (!buffer || buffer.byteLength < 8) {
          setErrorMsg('Selected file is too small to be a valid SWF or Video file.');
          return;
        }

        const bytes = new Uint8Array(buffer);
        const isAvi = VideoContainerParser.isAvi(bytes);
        const isFlv = VideoContainerParser.isFlv(bytes);
        const sig = String.fromCharCode(bytes[0], bytes[1], bytes[2]);
        const isSwf = sig === 'FWS' || sig === 'CWS' || sig === 'ZWS';

        if (!isSwf && !isAvi && !isFlv) {
          const ext = file.name.split('.').pop()?.toLowerCase() || '';
          if (!['avi', 'flv', 'mov', 'mp4', 'webm', '3gp', 'wmv', 'mpg', 'mpeg', 'm4v', 'gif'].includes(ext)) {
            setErrorMsg(
              `File "${file.name}" is not a recognized Flash SWF, AVI, or FLV video file.`
            );
            return;
          }
        }

        const formatLabel = isAvi ? 'AVI Video' : isFlv ? 'FLV Video' : 'Flash SWF';
        setSuccessMsg(`Successfully imported ${formatLabel}: ${file.name} (${(bytes.length / 1024).toFixed(1)} KB)`);
        onLoadSwf(bytes, file.name);
      } catch (err: any) {
        setErrorMsg(err?.message || 'Failed to read media file');
      }
    };

    reader.onerror = () => {
      setErrorMsg('Error reading file from device.');
    };
    reader.readAsArrayBuffer(file);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processFile(file);
      e.target.value = '';
    }
  };

  const openPicker = () => {
    if (useIosPickerFix) {
      iosInputRef.current?.click();
    } else {
      strictInputRef.current?.click();
    }
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      processFile(file);
    }
  };

  const handleLoadSample = (sampleType: 'star' | 'circle' | 'interactive' | 'video' | 'spark' | 'avi' | 'mask', name: string) => {
    try {
      if (sampleType === 'avi') {
        const aviBytes = buildSampleAvi();
        onLoadSwf(aviBytes, `${name}.avi`);
        setErrorMsg(null);
        setSuccessMsg(`Loaded sample: ${name}.avi (RIFF AVI DIB24 Stream)`);
      } else {
        const swfBytes = buildSampleSwf(sampleType);
        onLoadSwf(swfBytes, `${name}.swf`);
        setErrorMsg(null);
        setSuccessMsg(`Loaded sample: ${name}.swf`);
      }
    } catch (err: any) {
      setErrorMsg('Failed to build sample: ' + err.message);
    }
  };

  const handleDownloadSample = (sampleType: 'star' | 'circle' | 'interactive' | 'video' | 'spark' | 'avi' | 'mask', name: string) => {
    try {
      if (sampleType === 'avi') {
        const aviBytes = buildSampleAvi();
        const blob = new Blob([aviBytes.buffer as ArrayBuffer], { type: 'video/x-msvideo' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${name}.avi`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        const swfBytes = buildSampleSwf(sampleType);
        const blob = new Blob([swfBytes.buffer as ArrayBuffer], { type: 'application/x-shockwave-flash' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${name}.swf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (err: any) {
      setErrorMsg('Download failed: ' + err.message);
    }
  };

  const handleFetchUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!urlInput.trim()) return;

    setErrorMsg(null);
    setSuccessMsg(null);
    setIsFetchingUrl(true);

    try {
      const res = await fetch(urlInput.trim());
      if (!res.ok) {
        throw new Error(`HTTP Error ${res.status}: ${res.statusText}`);
      }
      const buffer = await res.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const fileName = urlInput.split('/').pop()?.split('?')[0] || 'remote_media.swf';
      onLoadSwf(bytes, fileName);
      setSuccessMsg(`Loaded media from URL: ${fileName}`);
      setUrlInput('');
    } catch (err: any) {
      setErrorMsg(`Failed to load from URL: ${err.message}. (Ensure the URL allows CORS).`);
    } finally {
      setIsFetchingUrl(false);
    }
  };

  return (
    <div className="w-full bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-6 shadow-xl text-slate-100">
      {/* 
        Picker 1 (iPad / iOS Unlocked):
        Omits restrictive accept attribute so Apple's iOS Files app doesn't grey out files.
      */}
      <input
        ref={iosInputRef}
        type="file"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Picker 2 (Video & SWF): */}
      <input
        ref={strictInputRef}
        type="file"
        accept=".swf,.avi,.flv,.mov,.mp4,.webm,.3gp,.wmv,.mpg,.mpeg"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* iPad Fix Toggle Banner */}
      <div className="mb-4 bg-slate-950/80 border border-slate-800 rounded-xl p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2.5">
          <Smartphone className="w-4 h-4 text-amber-400 shrink-0" />
          <div>
            <span className="font-semibold text-white">iPad / iOS &amp; Universal Media Mode: </span>
            <span className="text-slate-400">
              {useIosPickerFix
                ? 'Unlocked Mode active (Files app will NOT grey out your .swf or .avi files)'
                : 'Filtered Mode (.swf, .avi, .flv)'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <label className="flex items-center gap-2 cursor-pointer bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-700 hover:border-amber-400 transition-colors">
            <input
              type="checkbox"
              checked={useIosPickerFix}
              onChange={(e) => setUseIosPickerFix(e.target.checked)}
              className="accent-amber-500 rounded cursor-pointer"
            />
            <span className="text-slate-300 font-medium">iPad Greyed-Out Fix</span>
          </label>
        </div>
      </div>

      <div className="flex flex-col md:flex-row gap-6 items-stretch">
        {/* Dropzone Area */}
        <div
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
          onClick={openPicker}
          className={`flex-1 border-2 border-dashed rounded-xl p-6 sm:p-8 flex flex-col items-center justify-center text-center cursor-pointer transition-all duration-200 select-none ${
            dragActive
              ? 'border-amber-400 bg-amber-500/10 scale-[0.99]'
              : 'border-slate-700 hover:border-amber-500/70 hover:bg-slate-800/60 bg-slate-950/40'
          }`}
        >
          <div className="w-14 h-14 rounded-2xl bg-amber-500/20 text-amber-400 flex items-center justify-center mb-3 shadow-inner">
            <Upload className="w-7 h-7" />
          </div>

          <h3 className="text-lg font-semibold text-white mb-1">
            Choose or Drop a <span className="text-amber-400 font-mono">.swf</span> or <span className="text-cyan-400 font-mono">.avi</span> File
          </h3>
          <p className="text-sm text-slate-400 max-w-sm mb-4">
            Supports Flash SWF, Classic AVI, FLV, and older video streams with zero corruption!
          </p>

          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                iosInputRef.current?.click();
              }}
              className="px-5 py-2.5 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 active:scale-95 text-slate-950 font-bold rounded-xl shadow-lg transition-all flex items-center gap-2 text-sm"
            >
              <FileCode className="w-4 h-4" />
              Browse Files (Unlocked)
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                strictInputRef.current?.click();
              }}
              title="Open with media filter"
              className="px-3 py-2.5 bg-slate-800 hover:bg-slate-700 active:scale-95 text-slate-300 rounded-xl transition-all text-xs font-mono border border-slate-700"
            >
              .swf / .avi / .flv
            </button>
          </div>

          {activeFileName && (
            <div className="mt-3 inline-flex items-center gap-2 text-xs font-mono bg-emerald-950/80 border border-emerald-500/40 text-emerald-300 px-3 py-1 rounded-full">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              Playing: {activeFileName}
            </div>
          )}
        </div>

        {/* Built-in Instant Samples */}
        <div className="w-full md:w-80 flex flex-col justify-between bg-slate-950/60 border border-slate-800 rounded-xl p-4">
          <div>
            <div className="flex items-center gap-2 mb-2 text-amber-400 font-semibold text-sm">
              <Sparkles className="w-4 h-4" />
              <span>Instant Test Samples</span>
            </div>
            <p className="text-xs text-slate-400 mb-3">
              Test playing right now, or download files directly:
            </p>

            <div className="space-y-2">
              {/* Spotlight Mask Demo */}
              <div className="bg-slate-900 border border-violet-500/30 rounded-lg p-2.5 flex items-center justify-between group hover:border-violet-400 transition-colors">
                <div className="truncate pr-2">
                  <div className="text-xs font-medium text-violet-300 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-violet-400" />
                    <span>Spotlight Mask Demo</span>
                  </div>
                  <div className="text-[10px] text-slate-400">Vector Mask &amp; ClipDepth Layer (60f)</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => handleLoadSample('mask', 'SpotlightMask')}
                    title="Play Mask Sample"
                    className="p-1.5 rounded-lg bg-violet-500 hover:bg-violet-400 text-slate-950 font-medium transition-colors"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                  </button>
                  <button
                    onClick={() => handleDownloadSample('mask', 'SpotlightMask')}
                    title="Save .swf to Files"
                    className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Vintage AVI Video */}
              <div className="bg-slate-900 border border-cyan-500/30 rounded-lg p-2.5 flex items-center justify-between group hover:border-cyan-400 transition-colors">
                <div className="truncate pr-2">
                  <div className="text-xs font-medium text-cyan-300 flex items-center gap-1.5">
                    <Film className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Vintage AVI Video</span>
                  </div>
                  <div className="text-[10px] text-slate-400">RIFF AVI DIB24 Video (30f)</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => handleLoadSample('avi', 'VintageVideo')}
                    title="Play AVI Sample"
                    className="p-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-medium transition-colors"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                  </button>
                  <button
                    onClick={() => handleDownloadSample('avi', 'VintageVideo')}
                    title="Save .avi to Files"
                    className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Flash Video Stream */}
              <div className="bg-slate-900 border border-slate-800 rounded-lg p-2.5 flex items-center justify-between group hover:border-slate-700 transition-colors">
                <div className="truncate pr-2">
                  <div className="text-xs font-medium text-slate-200 flex items-center gap-1.5">
                    <Video className="w-3.5 h-3.5 text-rose-400" />
                    <span>Flash Video Stream</span>
                  </div>
                  <div className="text-[10px] text-slate-500">Tag 60/61 Video Stream (36f)</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => handleLoadSample('video', 'VideoStreamDemo')}
                    title="Play Video Stream Sample"
                    className="p-1.5 rounded-lg bg-rose-500 hover:bg-rose-400 text-slate-950 font-medium transition-colors"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                  </button>
                  <button
                    onClick={() => handleDownloadSample('video', 'VideoStreamDemo')}
                    title="Save .swf to Files"
                    className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Sorenson Spark Video */}
              <div className="bg-slate-900 border border-slate-800 rounded-lg p-2.5 flex items-center justify-between group hover:border-slate-700 transition-colors">
                <div className="truncate pr-2">
                  <div className="text-xs font-medium text-slate-200">Sorenson Spark Video</div>
                  <div className="text-[10px] text-slate-500">Clean H.263 Spark Stream (36f)</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => handleLoadSample('spark', 'SorensonSpark')}
                    title="Play Sorenson Spark Sample"
                    className="p-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-medium transition-colors"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                  </button>
                  <button
                    onClick={() => handleDownloadSample('spark', 'SorensonSpark')}
                    title="Save .swf to Files"
                    className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Bouncing Star Orbit */}
              <div className="bg-slate-900 border border-slate-800 rounded-lg p-2.5 flex items-center justify-between group hover:border-slate-700 transition-colors">
                <div className="truncate pr-2">
                  <div className="text-xs font-medium text-slate-200">Bouncing Star Orbit</div>
                  <div className="text-[10px] text-slate-500">Vector Star &amp; Motion Tween (60f)</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => handleLoadSample('star', 'StarOrbit')}
                    title="Play Sample"
                    className="p-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-medium transition-colors"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                  </button>
                  <button
                    onClick={() => handleDownloadSample('star', 'StarOrbit')}
                    title="Save .swf to Files"
                    className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-3 pt-2.5 border-t border-slate-800/80 text-[11px] text-slate-500 text-center">
            Drop <code className="text-slate-400 font-mono">.avi</code>, <code className="text-slate-400 font-mono">.flv</code>, or <code className="text-slate-400 font-mono">.swf</code> files anytime!
          </div>
        </div>
      </div>

      {/* URL Loader Bar */}
      <form onSubmit={handleFetchUrl} className="mt-4 pt-4 border-t border-slate-800/80 flex flex-col sm:flex-row gap-2">
        <div className="flex-1 relative">
          <LinkIcon className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="url"
            placeholder="Or enter direct SWF / AVI / FLV URL (e.g. https://example.com/video.avi)..."
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            className="w-full pl-9 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-amber-400"
          />
        </div>
        <button
          type="submit"
          disabled={isFetchingUrl || !urlInput.trim()}
          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 font-medium rounded-xl text-xs transition-colors shrink-0 flex items-center justify-center gap-1.5"
        >
          {isFetchingUrl ? 'Fetching...' : 'Load from URL'}
        </button>
      </form>

      {/* Error / Success Notifications */}
      {errorMsg && (
        <div className="mt-4 p-3.5 bg-rose-950/80 border border-rose-600/50 rounded-xl text-rose-200 text-xs">
          <strong>Notice: </strong>{errorMsg}
        </div>
      )}

      {successMsg && (
        <div className="mt-4 p-3 bg-emerald-950/80 border border-emerald-500/50 rounded-xl text-emerald-200 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}
    </div>
  );
};
