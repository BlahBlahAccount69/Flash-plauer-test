/**
 * Flash Player Web - Standalone SWF Player & Data Inspector
 * Built without Ruffle using pure HTML5 Canvas & SWF bitstream parser
 */

import React, { useState, useEffect } from 'react';
import { FileUploader } from './components/FileUploader';
import { SwfPlayerView } from './components/SwfPlayerView';
import { SwfInspector } from './components/SwfInspector';
import { SwfParser } from './swf/parser';
import { SwfFile } from './swf/types';
import { buildSampleSwf } from './swf/swfWriter';
import { downloadSwfAssetsZip } from './swf/assetExporter';
import { Zap, Play, AlertTriangle, Archive } from 'lucide-react';

export default function App() {
  const [swfFile, setSwfFile] = useState<SwfFile | null>(null);
  const [activeFileName, setActiveFileName] = useState<string>('StarOrbit.swf');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Load default sample on initial load so the user sees immediate animation
  useEffect(() => {
    try {
      const initialBytes = buildSampleSwf('star');
      loadSwfFromBytes(initialBytes, 'StarOrbit.swf');
    } catch (e: any) {
      console.warn('Initial sample load error:', e);
    }
  }, []);

  const loadSwfFromBytes = (bytes: Uint8Array, fileName: string) => {
    setIsLoading(true);
    setErrorMsg(null);
    // Unmount previous player immediately to guarantee zero overlapping instances
    setSwfFile(null);

    // Give a brief tick to allow UI to update
    setTimeout(() => {
      try {
        const parser = new SwfParser(bytes);
        const parsed = parser.parse();
        setActiveFileName(fileName);
        setSwfFile(parsed);
      } catch (err: any) {
        console.error('Failed to parse SWF:', err);
        setErrorMsg(err?.message || 'Failed to parse SWF binary file');
      } finally {
        setIsLoading(false);
      }
    }, 50);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-amber-500 selection:text-slate-950">
      {/* Top Navbar */}
      <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur sticky top-0 z-50 px-4 sm:px-8 py-3.5">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-amber-500 to-amber-600 flex items-center justify-center shadow-lg shadow-amber-500/20 text-slate-950 font-black">
              <Zap className="w-5 h-5 fill-current" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base sm:text-lg font-bold tracking-tight text-white">
                  Flash Player Web
                </h1>
                <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
                  Native Engine
                </span>
              </div>
              <p className="text-[11px] text-slate-400 hidden sm:block">
                SWF Player, Bitstream Parser &amp; Inspector (No Ruffle)
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="text-xs text-slate-400 font-mono hidden md:flex items-center gap-1.5 bg-slate-950/80 px-3 py-1.5 rounded-xl border border-slate-800">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              <span>iOS &amp; iPad File Picker Ready</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-7xl mx-auto w-full p-4 sm:p-6 lg:p-8 flex-1 space-y-6">
        {/* Error Alert Banner */}
        {errorMsg && (
          <div className="p-4 bg-rose-950/80 border border-rose-500/50 rounded-2xl flex items-start gap-3 shadow-lg">
            <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
            <div>
              <h3 className="font-semibold text-rose-200 text-sm">Failed to Load SWF</h3>
              <p className="text-xs text-rose-300/90 mt-0.5">{errorMsg}</p>
            </div>
          </div>
        )}

        {/* SWF Player Section */}
        {swfFile && (
          <section className="space-y-2">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2">
                <Play className="w-4 h-4 text-amber-400" />
                <span>Active Flash Stage</span>
              </h2>

              <button
                onClick={() => downloadSwfAssetsZip(swfFile, activeFileName)}
                className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-400 active:scale-95 text-slate-950 transition-all shadow-md shadow-amber-500/20 cursor-pointer"
                title="Install / Download all SWF assets as a ZIP file"
              >
                <Archive className="w-3.5 h-3.5 fill-current" />
                <span>Install All Assets (.zip)</span>
              </button>
            </div>
            <SwfPlayerView key={activeFileName} swf={swfFile} fileName={activeFileName} />
          </section>
        )}

        {/* File Uploader with accept=".swf" */}
        <section>
          <FileUploader
            onLoadSwf={loadSwfFromBytes}
            isLoading={isLoading}
            activeFileName={activeFileName}
          />
        </section>

        {/* SWF Data & Bytecode Inspector */}
        {swfFile && (
          <section className="space-y-2">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
                SWF Data &amp; Tag Breakdown
              </h2>
            </div>
            <SwfInspector swf={swfFile} fileName={activeFileName} />
          </section>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 bg-slate-950 py-6 px-4 text-center text-xs text-slate-500">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3">
          <div>
            Flash Player Web • Independent SWF Bitstream &amp; Canvas 2D Engine
          </div>
          <div className="text-[11px] font-mono text-slate-600">
            Accepts <code className="text-slate-400">.swf</code> • FWS / CWS Flash 4-10
          </div>
        </div>
      </footer>
    </div>
  );
}
