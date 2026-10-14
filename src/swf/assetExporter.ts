/**
 * SWF Asset Exporter & ZIP Bundler
 * Extracts all assets (Images, MP3/WAV Audio, SVG Vector Shapes, Texts, Scripts, Manifest)
 * and packages them into a downloadable .zip archive using fflate.
 */

import { zipSync, Zippable } from 'fflate';
import { SwfFile, SwfShape } from './types';
import { fixMojibake } from './stringUtils';
import { VideoDecoderEngine } from './videoDecoder';

function dataUrlToBytes(dataUrl: string): Uint8Array {
  try {
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx === -1) return new Uint8Array(0);
    const base64 = dataUrl.substring(commaIdx + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
}

function shapeToSvg(shape: SwfShape): string {
  const width = Math.max(1, Math.round(shape.bounds.width));
  const height = Math.max(1, Math.round(shape.bounds.height));
  const xmin = shape.bounds.xmin / 20.0;
  const ymin = shape.bounds.ymin / 20.0;

  const defs: string[] = [];
  const fillStyleMap = new Map<number, string>();

  // Build SVG gradients for fill styles
  shape.fillStyles.forEach((fs, idx) => {
    const fillId = `shape_${shape.id}_fill_${idx + 1}`;
    if (fs.type === 'solid' && fs.color) {
      fillStyleMap.set(idx + 1, `rgba(${fs.color.r}, ${fs.color.g}, ${fs.color.b}, ${fs.color.a})`);
    } else if (
      (fs.type === 'linearGradient' || fs.type === 'radialGradient') &&
      fs.gradients &&
      fs.gradients.length > 0
    ) {
      const gm = fs.gradientMatrix || {
        scaleX: 1,
        scaleY: 1,
        rotateSkew0: 0,
        rotateSkew1: 0,
        translateX: 0,
        translateY: 0,
      };

      const sortedStops = [...fs.gradients].sort((a, b) => a.ratio - b.ratio);
      const stopsSvg = sortedStops
        .map(
          (rec) =>
            `<stop offset="${(rec.ratio / 255.0).toFixed(3)}" stop-color="rgb(${rec.color.r},${rec.color.g},${rec.color.b})" stop-opacity="${rec.color.a.toFixed(3)}" />`
        )
        .join('');

      if (fs.type === 'linearGradient') {
        const a = gm.scaleX ?? 1;
        const b = gm.rotateSkew0 ?? 0;
        const tx = gm.translateX ?? 0;
        const ty = gm.translateY ?? 0;
        const x0 = -819.2 * a + tx;
        const y0 = -819.2 * b + ty;
        const x1 = 819.2 * a + tx;
        const y1 = 819.2 * b + ty;

        defs.push(
          `<linearGradient id="${fillId}" gradientUnits="userSpaceOnUse" x1="${x0.toFixed(2)}" y1="${y0.toFixed(2)}" x2="${x1.toFixed(2)}" y2="${y1.toFixed(2)}">${stopsSvg}</linearGradient>`
        );
      } else {
        const a = gm.scaleX ?? 1;
        const b = gm.rotateSkew0 ?? 0;
        const c = gm.rotateSkew1 ?? 0;
        const d = gm.scaleY ?? 1;
        const tx = gm.translateX ?? 0;
        const ty = gm.translateY ?? 0;
        const r = Math.max(0.1, 819.2 * Math.sqrt((a * a + b * b + c * c + d * d) / 2));

        defs.push(
          `<radialGradient id="${fillId}" gradientUnits="userSpaceOnUse" cx="${tx.toFixed(2)}" cy="${ty.toFixed(2)}" r="${r.toFixed(2)}" fx="${tx.toFixed(2)}" fy="${ty.toFixed(2)}">${stopsSvg}</radialGradient>`
        );
      }
      fillStyleMap.set(idx + 1, `url(#${fillId})`);
    } else {
      fillStyleMap.set(idx + 1, 'none');
    }
  });

  let pathSvg = '';
  for (const path of shape.paths) {
    let d = '';
    for (const cmd of path.commands) {
      if (cmd.type === 'moveTo') {
        d += `M ${cmd.x.toFixed(2)} ${cmd.y.toFixed(2)} `;
      } else if (cmd.type === 'lineTo') {
        d += `L ${cmd.x.toFixed(2)} ${cmd.y.toFixed(2)} `;
      } else if (cmd.type === 'curveTo') {
        d += `Q ${cmd.cx.toFixed(2)} ${cmd.cy.toFixed(2)} ${cmd.ax.toFixed(2)} ${cmd.ay.toFixed(2)} `;
      }
    }

    if (d.trim()) {
      let fill = 'none';
      if (path.fillStyle0 > 0 && fillStyleMap.has(path.fillStyle0)) {
        fill = fillStyleMap.get(path.fillStyle0)!;
      } else if (path.fillStyle1 > 0 && fillStyleMap.has(path.fillStyle1)) {
        fill = fillStyleMap.get(path.fillStyle1)!;
      }

      let stroke = 'none';
      let strokeWidth = '1';
      if (path.lineStyle > 0 && path.lineStyle <= shape.lineStyles.length) {
        const ls = shape.lineStyles[path.lineStyle - 1];
        if (ls.color) {
          stroke = `rgba(${ls.color.r}, ${ls.color.g}, ${ls.color.b}, ${ls.color.a})`;
        }
        strokeWidth = String(Math.max(0.5, ls.width || 1));
      }

      pathSvg += `  <path d="${d.trim()}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" fill-rule="evenodd" />\n`;
    }
  }

  const defsContent = defs.length > 0 ? `  <defs>\n    ${defs.join('\n    ')}\n  </defs>\n` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${xmin.toFixed(2)} ${ymin.toFixed(2)} ${width} ${height}" width="${width}" height="${height}">
${defsContent}${pathSvg}</svg>`;
}

function createWavFile(
  audioData: Uint8Array,
  sampleRate: number,
  channels: number,
  bitsPerSample: number
): Uint8Array {
  const dataSize = audioData.length;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true); // ByteRate
  view.setUint16(32, channels * (bitsPerSample / 8), true); // BlockAlign
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  new Uint8Array(buffer, 44).set(audioData);
  return new Uint8Array(buffer);
}

export interface ExportProgress {
  status: string;
  totalAssets: number;
}

/**
 * Packages all assets in the SWF into a ZIP file and triggers a browser download.
 */
export async function downloadSwfAssetsZip(
  swf: SwfFile,
  fileName = 'FlashMovie.swf',
  onProgress?: (progress: ExportProgress) => void
): Promise<void> {
  const baseName = fileName.replace(/\.[^/.]+$/, '');
  const encoder = new TextEncoder();
  const zipFiles: Zippable = {};

  onProgress?.({ status: 'Collecting metadata...', totalAssets: 0 });

  // 1. Raw SWF file
  if (swf.rawBytes && swf.rawBytes.length > 0) {
    zipFiles[`${baseName}.swf`] = swf.rawBytes;
  }

  // 2. Manifest JSON
  const manifest = {
    fileName: `${baseName}.swf`,
    signature: swf.signature,
    version: swf.version,
    dimensions: {
      width: Math.round(swf.frameSize.width),
      height: Math.round(swf.frameSize.height),
      twipsWidth: swf.frameSize.xmax - swf.frameSize.xmin,
      twipsHeight: swf.frameSize.ymax - swf.frameSize.ymin,
    },
    frameRate: swf.frameRate,
    frameCount: swf.frameCount,
    durationSeconds: Number((swf.frameCount / (swf.frameRate || 12)).toFixed(2)),
    backgroundColor: `#${((1 << 24) + (swf.backgroundColor.r << 16) + (swf.backgroundColor.g << 8) + swf.backgroundColor.b).toString(16).slice(1)}`,
    assetCounts: {
      bitmaps: swf.bitmaps.size,
      shapes: swf.shapes.size,
      videos: swf.videoStreams ? swf.videoStreams.size : 0,
      sounds: swf.sounds.size + (swf.streamSound ? 1 : 0),
      texts: swf.texts.size,
      fonts: swf.fonts.size,
      sprites: swf.sprites.size,
      buttons: swf.buttons.size,
      totalTags: swf.tags.length,
    },
  };
  zipFiles['manifest.json'] = encoder.encode(JSON.stringify(manifest, null, 2));

  // 3. Extracted Bitmaps / Images
  onProgress?.({ status: 'Exporting bitmaps...', totalAssets: swf.bitmaps.size });
  let imgIndex = 1;
  for (const [id, bmp] of swf.bitmaps.entries()) {
    const ext = bmp.format === 'jpeg' ? 'jpg' : 'png';
    const imgName = `images/bitmap_${id || imgIndex}.${ext}`;

    if (bmp.rawBytes && bmp.rawBytes.length > 0) {
      zipFiles[imgName] = bmp.rawBytes;
    } else if (bmp.dataUrl) {
      const bytes = dataUrlToBytes(bmp.dataUrl);
      if (bytes.length > 0) {
        zipFiles[imgName] = bytes;
      }
    }
    imgIndex++;
  }

  // 3.5. Extracted Videos (Embedded SWF Video Streams)
  if (swf.videoStreams && swf.videoStreams.size > 0) {
    onProgress?.({ status: 'Exporting video streams...', totalAssets: swf.videoStreams.size });
    for (const [vId, stream] of swf.videoStreams.entries()) {
      const videoInfo = {
        streamId: vId,
        width: stream.width,
        height: stream.height,
        numFrames: stream.numFrames,
        codecId: stream.codecId,
        codecName: stream.codecName,
        smoothing: stream.smoothing,
        deblocking: stream.deblocking,
        totalPackets: stream.frames.size,
      };
      zipFiles[`videos/stream_${vId}/video_info.json`] = encoder.encode(JSON.stringify(videoInfo, null, 2));

      // Export decoded frames as PNG images
      for (const [fNum] of stream.frames.entries()) {
        try {
          const frameCanvas = await VideoDecoderEngine.decodeFrame(stream, fNum);
          if (frameCanvas) {
            const dataUrl = frameCanvas.toDataURL('image/png');
            const bytes = dataUrlToBytes(dataUrl);
            if (bytes.length > 0) {
              const padNum = String(fNum + 1).padStart(4, '0');
              zipFiles[`videos/stream_${vId}/frame_${padNum}.png`] = bytes;
            }
          }
        } catch {
          // ignore individual frame extraction errors
        }
      }
    }
  }

  // 4. Extracted Audio
  onProgress?.({ status: 'Exporting audio...', totalAssets: swf.sounds.size });
  if (swf.streamSound && swf.streamSound.allMp3Bytes.length > 0) {
    zipFiles['audio/soundtrack.mp3'] = swf.streamSound.allMp3Bytes;
  }

  for (const [id, sound] of swf.sounds.entries()) {
    if (sound.format === 2 && sound.data.length > 2) {
      // MP3 audio (first 2 bytes are seek samples)
      const mp3Data = sound.data.slice(2);
      zipFiles[`audio/sound_${id}.mp3`] = mp3Data;
    } else if (sound.format === 0 && sound.data.length > 0) {
      // PCM WAV audio
      const wavBytes = createWavFile(
        sound.data,
        sound.rate,
        sound.isStereo ? 2 : 1,
        sound.is16Bit ? 16 : 8
      );
      zipFiles[`audio/sound_${id}.wav`] = wavBytes;
    }
  }

  // 5. Extracted Vector Shapes (as SVG files)
  onProgress?.({ status: 'Exporting vector shapes...', totalAssets: swf.shapes.size });
  for (const [id, shape] of swf.shapes.entries()) {
    const svgContent = shapeToSvg(shape);
    zipFiles[`shapes/shape_${id}.svg`] = encoder.encode(svgContent);
  }

  // 6. Extracted Texts (all texts cleanly decoded without mojibake)
  onProgress?.({ status: 'Exporting texts...', totalAssets: swf.texts.size });
  const allTextsList: { id: number; text: string; initialText?: string; fontId?: number }[] = [];
  let compiledText = `=== FLASH SWF EXTRACTED TEXTS ===\nFile: ${fileName}\nTotal Texts: ${swf.texts.size}\n\n`;

  for (const [id, t] of swf.texts.entries()) {
    const cleanText = fixMojibake(t.initialText || '');
    allTextsList.push({
      id,
      text: cleanText,
      initialText: t.initialText,
      fontId: t.fontId,
    });
    if (cleanText.trim()) {
      compiledText += `--- [Text ID ${id}] ---\n${cleanText}\n\n`;
    }
  }

  zipFiles['texts/all_texts.txt'] = encoder.encode(compiledText);
  zipFiles['texts/texts_detail.json'] = encoder.encode(JSON.stringify(allTextsList, null, 2));

  // 7. Extracted Fonts Information
  if (swf.fonts.size > 0) {
    const fontsList: any[] = [];
    let fontsTxt = `=== FLASH SWF FONTS ===\nTotal Fonts: ${swf.fonts.size}\n\n`;

    for (const [id, font] of swf.fonts.entries()) {
      const cleanFontName = fixMojibake(font.name || `Font_${id}`);
      fontsList.push({
        id,
        name: cleanFontName,
        isBold: font.isBold,
        isItalic: font.isItalic,
        isShiftJIS: font.isShiftJIS,
        languageCode: font.languageCode,
        glyphCount: font.codeTable ? font.codeTable.length : font.glyphShapes?.length || 0,
      });
      fontsTxt += `Font ID ${id}: "${cleanFontName}" ${font.isBold ? '[Bold]' : ''} ${font.isItalic ? '[Italic]' : ''}\n`;
      fontsTxt += `  Glyphs: ${font.codeTable ? font.codeTable.length : font.glyphShapes?.length || 0}\n\n`;
    }

    zipFiles['fonts/fonts_info.txt'] = encoder.encode(fontsTxt);
    zipFiles['fonts/fonts_info.json'] = encoder.encode(JSON.stringify(fontsList, null, 2));
  }

  // 8. ActionScript Bytecode
  const frameActions: { frame: number; actions: any[] }[] = [];
  let actionsTxt = `=== FLASH SWF ACTIONSCRIPT SCRIPTS ===\nFile: ${fileName}\n\n`;
  let hasActions = false;

  swf.mainFrames.forEach((frame, idx) => {
    if (frame.actions && frame.actions.length > 0) {
      hasActions = true;
      frameActions.push({ frame: idx + 1, actions: frame.actions });
      actionsTxt += `--- Frame ${idx + 1} Script ---\n`;
      frame.actions.forEach((act, aIdx) => {
        actionsTxt += `  ${aIdx + 1}. ${act.name}${act.args ? ' ' + JSON.stringify(act.args) : ''}\n`;
      });
      actionsTxt += '\n';
    }
  });

  if (hasActions) {
    zipFiles['scripts/actionscript.txt'] = encoder.encode(actionsTxt);
    zipFiles['scripts/actionscript.json'] = encoder.encode(JSON.stringify(frameActions, null, 2));
  }

  // 9. Compress and Download
  onProgress?.({ status: 'Building ZIP archive...', totalAssets: Object.keys(zipFiles).length });

  const zipBytes = zipSync(zipFiles, { level: 6 });
  const blob = new Blob([zipBytes.buffer as ArrayBuffer], { type: 'application/zip' });
  const downloadUrl = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = `${baseName}_assets.zip`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  setTimeout(() => {
    URL.revokeObjectURL(downloadUrl);
  }, 1000);
}
