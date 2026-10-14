/**
 * SWF (Shockwave Flash) Binary Parser
 * Supports FWS (uncompressed) and CWS (zlib compressed)
 * Supports Vector Shapes (1-4), Sound Streams (MP3), Sprites, Fonts & Texts
 */

import { unzlibSync } from 'fflate';
import { BitReader } from './bitReader';
import { decodeCharCode, decodeSwfString, fixMojibake } from './stringUtils';
import { VideoContainerParser } from './videoContainerParser';
import { VideoDecoderEngine } from './videoDecoder';
import { buildPathsFromMorphEdges } from './morphUtils';
import {
  SwfAction,
  SwfBitmap,
  SwfButton,
  SwfButtonRecord,
  SwfColorRGBA,
  SwfDisplayObject,
  SwfFile,
  SwfFillStyle,
  SwfFont,
  SwfFrame,
  SwfGradientRecord,
  SwfLineStyle,
  SwfMatrix,
  SwfMorphEdge,
  SwfMorphFillStyle,
  SwfMorphLineStyle,
  SwfMorphShape,
  SwfRect,
  SwfShape,
  SwfShapePath,
  SwfSound,
  SwfSprite,
  SwfStreamSound,
  SwfTagInfo,
  SwfText,
  SwfTextRecord,
  SwfVideoStream,
} from './types';

// SWF Tag Codes mapping
export const TAG_NAMES: Record<number, string> = {
  0: 'End',
  1: 'ShowFrame',
  2: 'DefineShape',
  4: 'PlaceObject',
  5: 'RemoveObject',
  6: 'DefineBits',
  7: 'DefineButton',
  8: 'JPEGTables',
  9: 'SetBackgroundColor',
  10: 'DefineFont',
  11: 'DefineText',
  12: 'DoAction',
  13: 'DefineFontInfo',
  14: 'DefineSound',
  15: 'StartSound',
  18: 'SoundStreamHead',
  19: 'SoundStreamBlock',
  20: 'DefineBitsLossless',
  21: 'DefineBitsJPEG2',
  22: 'DefineShape2',
  24: 'Protect',
  26: 'PlaceObject2',
  28: 'RemoveObject2',
  32: 'DefineShape3',
  33: 'DefineText2',
  34: 'DefineButton2',
  35: 'DefineBitsJPEG3',
  36: 'DefineBitsLossless2',
  37: 'DefineEditText',
  39: 'DefineSprite',
  43: 'FrameLabel',
  45: 'SoundStreamHead2',
  46: 'DefineMorphShape',
  48: 'DefineFont2',
  56: 'ExportAssets',
  58: 'EnableDebugger',
  59: 'DoInitAction',
  60: 'DefineVideoStream',
  61: 'VideoFrame',
  62: 'DefineFontInfo2',
  64: 'EnableDebugger2',
  65: 'ScriptLimits',
  66: 'SetTabIndex',
  69: 'FileAttributes',
  70: 'PlaceObject3',
  71: 'ImportAssets2',
  73: 'DefineFontAlignZones',
  74: 'CSMTextSettings',
  75: 'DefineFont3',
  76: 'SymbolClass',
  77: 'Metadata',
  78: 'DefineScalingGrid',
  82: 'DoABC',
  83: 'DefineShape4',
  84: 'DefineMorphShape2',
  86: 'DefineSceneAndFrameLabelData',
  87: 'DefineBinaryData',
  88: 'DefineFontName',
  89: 'StartSound2',
  90: 'DefineBitsJPEG4',
};

export class SwfParser {
  private reader: BitReader;
  private rawBytes: Uint8Array;
  private fileLength = 0;
  private uncompressedLength = 0;
  private signature: 'FWS' | 'CWS' | 'ZWS' = 'FWS';
  private version = 1;
  private frameSize: SwfRect = { nbits: 0, xmin: 0, xmax: 0, ymin: 0, ymax: 0, width: 550, height: 400 };
  private frameRate = 12;
  private frameCount = 1;
  private backgroundColor: SwfColorRGBA = { r: 255, g: 255, b: 255, a: 1 };

  private tags: SwfTagInfo[] = [];
  private shapes = new Map<number, SwfShape>();
  private morphShapes = new Map<number, SwfMorphShape>();
  private bitmaps = new Map<number, SwfBitmap>();
  private texts = new Map<number, SwfText>();
  private fonts = new Map<number, SwfFont>();
  private sprites = new Map<number, SwfSprite>();
  private buttons = new Map<number, SwfButton>();
  private sounds = new Map<number, SwfSound>();
  private videoStreams = new Map<number, SwfVideoStream>();
  private mainFrames: SwfFrame[] = [];
  private jpegTables: Uint8Array | null = null;

  // Sound streaming state
  private streamSoundConfig?: {
    format: number;
    playbackRate: number;
    streamRate: number;
    is16Bit: boolean;
    isStereo: boolean;
    sampleCount: number;
  };
  private streamMp3Chunks: Uint8Array[] = [];

  constructor(bytes: Uint8Array) {
    this.rawBytes = bytes;
    this.reader = new BitReader(bytes);
  }

  public parse(): SwfFile {
    if (this.rawBytes.length < 8) {
      throw new Error('File is too short to be a valid SWF or Video file');
    }

    // Direct AVI and FLV Container Detection
    if (VideoContainerParser.isAvi(this.rawBytes)) {
      return VideoContainerParser.parseAvi(this.rawBytes);
    }
    if (VideoContainerParser.isFlv(this.rawBytes)) {
      return VideoContainerParser.parseFlv(this.rawBytes);
    }

    // 1. Read Header
    const sig0 = String.fromCharCode(this.reader.readUI8());
    const sig1 = String.fromCharCode(this.reader.readUI8());
    const sig2 = String.fromCharCode(this.reader.readUI8());
    const sig = (sig0 + sig1 + sig2) as 'FWS' | 'CWS' | 'ZWS';

    if (sig !== 'FWS' && sig !== 'CWS' && sig !== 'ZWS') {
      throw new Error(`Invalid format signature: ${sig}. Supported formats: Flash SWF (FWS/CWS), AVI Video (RIFF), and Flash Video (FLV).`);
    }
    this.signature = sig;
    this.version = this.reader.readUI8();
    this.fileLength = this.reader.readUI32();
    this.uncompressedLength = this.fileLength;

    let decompressedBytes: Uint8Array;
    if (sig === 'CWS') {
      // Decompress starting at byte 8 using zlib/deflate
      try {
        const compressedData = this.rawBytes.subarray(8);
        const unzipped = unzlibSync(compressedData);
        decompressedBytes = new Uint8Array(8 + unzipped.length);
        decompressedBytes.set(this.rawBytes.subarray(0, 8), 0);
        decompressedBytes.set(unzipped, 8);
        this.uncompressedLength = decompressedBytes.length;
      } catch (err) {
        console.warn('Zlib decompression error:', err);
        throw new Error('Failed to decompress CWS Flash file: corrupted zlib stream');
      }
    } else if (sig === 'ZWS') {
      throw new Error('LZMA compressed SWF (ZWS) is not supported. Please use FWS or CWS SWF.');
    } else {
      decompressedBytes = this.rawBytes;
    }

    this.reader = new BitReader(decompressedBytes, 8);

    // Read Frame Size (RECT)
    this.frameSize = this.reader.readRect();
    // Read Frame Rate (8.8 fixed point)
    this.frameRate = this.reader.readFIXED8();
    if (this.frameRate <= 0 || isNaN(this.frameRate)) {
      this.frameRate = 12;
    }
    // Read Frame Count
    this.frameCount = this.reader.readUI16();

    // 2. Parse Tags Stream
    this.parseTags();

    // Assemble continuous MP3 stream if streaming sound blocks were found
    let streamSound: SwfStreamSound | undefined;
    if (this.streamMp3Chunks.length > 0 && this.streamSoundConfig) {
      let totalBytes = 0;
      for (const chunk of this.streamMp3Chunks) {
        totalBytes += chunk.length;
      }
      const combinedMp3 = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of this.streamMp3Chunks) {
        combinedMp3.set(chunk, offset);
        offset += chunk.length;
      }

      streamSound = {
        format: this.streamSoundConfig.format,
        playbackRate: this.streamSoundConfig.playbackRate,
        streamRate: this.streamSoundConfig.streamRate,
        is16Bit: this.streamSoundConfig.is16Bit,
        isStereo: this.streamSoundConfig.isStereo,
        sampleCount: this.streamSoundConfig.sampleCount,
        allMp3Bytes: combinedMp3,
      };
    }

    return {
      signature: this.signature,
      version: this.version,
      fileLength: this.fileLength,
      uncompressedLength: this.uncompressedLength,
      frameSize: this.frameSize,
      frameRate: this.frameRate,
      frameCount: Math.max(1, this.mainFrames.length || this.frameCount),
      backgroundColor: this.backgroundColor,
      tags: this.tags,
      shapes: this.shapes,
      morphShapes: this.morphShapes,
      bitmaps: this.bitmaps,
      texts: this.texts,
      fonts: this.fonts,
      sprites: this.sprites,
      buttons: this.buttons,
      sounds: this.sounds,
      videoStreams: this.videoStreams,
      streamSound,
      mainFrames: this.mainFrames,
      rawBytes: this.rawBytes,
    };
  }

  private parseTags(): void {
    let currentFrameIndex = 0;
    // Active display list for main timeline
    const activeDisplayList = new Map<number, SwfDisplayObject>();

    let currentFrame: SwfFrame = {
      frameIndex: currentFrameIndex,
      actions: [],
      placedObjects: [],
      removedDepths: [],
      startSounds: [],
    };

    while (!this.reader.eof && this.reader.remaining >= 2) {
      const tagOffset = this.reader.pos;
      const tagCodeAndLength = this.reader.readUI16();
      const tagCode = tagCodeAndLength >> 6;
      let tagLength = tagCodeAndLength & 0x3f;

      if (tagLength === 0x3f) {
        if (this.reader.remaining < 4) break;
        tagLength = this.reader.readUI32();
      }

      if (tagCode === 0) {
        // End Tag
        this.tags.push({
          code: 0,
          name: 'End',
          offset: tagOffset,
          length: tagLength,
          summary: 'End of SWF Tag Stream',
        });
        break;
      }

      const tagStartPos = this.reader.pos;
      const tagEndPos = Math.min(this.reader.bytes.length, tagStartPos + tagLength);

      const tagName = TAG_NAMES[tagCode] || `UnknownTag_${tagCode}`;
      const tagInfo: SwfTagInfo = {
        code: tagCode,
        name: tagName,
        offset: tagOffset,
        length: tagLength,
      };

      try {
        switch (tagCode) {
          case 1: // ShowFrame
            tagInfo.summary = `Frame ${currentFrameIndex + 1}`;
            // Snapshot current display list into this frame!
            currentFrame.displaySnapshot = this.cloneDisplayList(activeDisplayList);
            this.mainFrames.push(currentFrame);
            currentFrameIndex++;
            currentFrame = {
              frameIndex: currentFrameIndex,
              actions: [],
              placedObjects: [],
              removedDepths: [],
              startSounds: [],
            };
            break;

          case 8: // JPEGTables
            this.jpegTables = this.reader.readBytes(tagLength);
            tagInfo.summary = `JPEG Tables (${this.jpegTables.length} bytes)`;
            break;

          case 9: // SetBackgroundColor
            this.backgroundColor = this.reader.readRGB();
            tagInfo.summary = `RGB(${this.backgroundColor.r}, ${this.backgroundColor.g}, ${this.backgroundColor.b})`;
            break;

          case 2: // DefineShape
          case 22: // DefineShape2
          case 32: // DefineShape3
          case 83: // DefineShape4
            this.parseDefineShape(tagCode, tagInfo);
            break;

          case 46: // DefineMorphShape
          case 84: // DefineMorphShape2
            this.parseDefineMorphShape(tagCode, tagInfo);
            break;

          case 4: // PlaceObject
            this.parsePlaceObject(currentFrame, activeDisplayList, tagInfo);
            break;

          case 26: // PlaceObject2
          case 70: // PlaceObject3
            this.parsePlaceObject2(currentFrame, activeDisplayList, tagInfo, tagCode === 70);
            break;

          case 5: // RemoveObject
          case 28: // RemoveObject2
            this.parseRemoveObject(currentFrame, activeDisplayList, tagInfo, tagCode === 28);
            break;

          case 6: // DefineBits
          case 21: // DefineBitsJPEG2
          case 35: // DefineBitsJPEG3
          case 90: // DefineBitsJPEG4
            this.parseDefineBitsJPEG(tagCode, tagLength, tagInfo);
            break;

          case 20: // DefineBitsLossless
          case 36: // DefineBitsLossless2
            this.parseDefineBitsLossless(tagCode, tagLength, tagInfo);
            break;

          case 12: // DoAction
            this.parseDoAction(currentFrame, tagLength, tagInfo);
            break;

          case 43: // FrameLabel
            const label = this.reader.readString();
            currentFrame.label = label;
            tagInfo.summary = `"${label}"`;
            break;

          case 39: // DefineSprite (MovieClip)
            this.parseDefineSprite(tagInfo);
            break;

          case 7: // DefineButton
          case 34: // DefineButton2
            this.parseDefineButton(tagCode, tagLength, tagInfo);
            break;

          case 10: // DefineFont
          case 48: // DefineFont2
          case 75: // DefineFont3
            this.parseDefineFont(tagCode, tagLength, tagInfo);
            break;

          case 13: // DefineFontInfo
          case 62: // DefineFontInfo2
            this.parseDefineFontInfo(tagCode, tagLength, tagInfo);
            break;

          case 11: // DefineText
          case 33: // DefineText2
            this.parseDefineText(tagCode, tagLength, tagInfo);
            break;

          case 37: // DefineEditText
            this.parseDefineEditText(tagLength, tagInfo);
            break;

          case 14: // DefineSound
            this.parseDefineSound(tagLength, tagInfo);
            break;

          case 15: // StartSound
            this.parseStartSound(currentFrame, tagInfo);
            break;

          case 18: // SoundStreamHead
          case 45: // SoundStreamHead2
            this.parseSoundStreamHead(tagCode, tagLength, tagInfo);
            break;

          case 19: // SoundStreamBlock
            this.parseSoundStreamBlock(tagLength, tagInfo);
            break;

          case 60: // DefineVideoStream
            this.parseDefineVideoStream(tagInfo);
            break;

          case 61: // VideoFrame
            this.parseVideoFrame(tagLength, tagInfo);
            break;

          default:
            break;
        }
      } catch (err) {
        console.warn(`Error parsing tag ${tagName} (code ${tagCode}):`, err);
      }

      this.tags.push(tagInfo);
      this.reader.pos = tagEndPos;
      this.reader.bitPos = 0;
    }

    // Finalize last frame if not already added
    if (
      currentFrame.placedObjects.length > 0 ||
      currentFrame.actions.length > 0 ||
      currentFrame.removedDepths.length > 0
    ) {
      currentFrame.displaySnapshot = this.cloneDisplayList(activeDisplayList);
      this.mainFrames.push(currentFrame);
    }

    if (this.mainFrames.length === 0) {
      this.mainFrames.push({
        frameIndex: 0,
        actions: [],
        placedObjects: [],
        removedDepths: [],
        startSounds: [],
        displaySnapshot: new Map(),
      });
    }
  }

  private cloneDisplayList(map: Map<number, SwfDisplayObject>): Map<number, SwfDisplayObject> {
    const copy = new Map<number, SwfDisplayObject>();
    for (const [k, v] of map.entries()) {
      copy.set(k, {
        depth: v.depth,
        characterId: v.characterId,
        matrix: { ...v.matrix },
        colorTransform: v.colorTransform ? { ...v.colorTransform } : undefined,
        clipDepth: v.clipDepth,
        name: v.name,
        ratio: v.ratio,
      });
    }
    return copy;
  }

  private parseDefineShape(tagCode: number, tagInfo: SwfTagInfo): void {
    const shapeId = this.reader.readUI16();
    tagInfo.characterId = shapeId;

    const bounds = this.reader.readRect();
    if (tagCode === 83) {
      this.reader.readRect(); // edgeBounds
      this.reader.readUB(5); // reserved flags
      this.reader.readUB(1); // usesFillWindingRule
      this.reader.readUB(1); // usesNonScalingStrokes
      this.reader.readUB(1); // usesScalingStrokes
      this.reader.alignByte();
    }

    const fillStyles = this.parseFillStyleArray(tagCode);
    const lineStyles = this.parseLineStyleArray(tagCode);

    const paths = this.parseShapeRecords(fillStyles, lineStyles, tagCode);

    const shape: SwfShape = {
      id: shapeId,
      bounds,
      fillStyles,
      lineStyles,
      paths,
    };

    this.shapes.set(shapeId, shape);
    tagInfo.summary = `Shape ID ${shapeId} (${Math.round(bounds.width)}x${Math.round(bounds.height)}px, ${paths.length} paths)`;
  }

  private parseSingleFillStyle(tagCode: number): SwfFillStyle {
    const fillStyleType = this.reader.readUI8();
    const style: SwfFillStyle = { type: 'solid' };
    const hasAlpha = tagCode === 32 || tagCode === 83 || tagCode === 46 || tagCode === 84;

    if (fillStyleType === 0x00) {
      // Solid fill
      style.type = 'solid';
      style.color = hasAlpha ? this.reader.readRGBA() : this.reader.readRGB();
    } else if (
      fillStyleType === 0x10 ||
      fillStyleType === 0x12 ||
      fillStyleType === 0x13
    ) {
      // Gradient fill
      style.type = fillStyleType === 0x10 ? 'linearGradient' : 'radialGradient';
      style.gradientMatrix = this.reader.readMatrix();

      this.reader.alignByte();
      this.reader.readUB(2); // SpreadMode
      this.reader.readUB(2); // InterpolationMode
      const numGradients = this.reader.readUB(4);

      const gradients: SwfGradientRecord[] = [];
      for (let g = 0; g < numGradients; g++) {
        const ratio = this.reader.readUI8();
        const color = hasAlpha ? this.reader.readRGBA() : this.reader.readRGB();
        gradients.push({ ratio, color });
      }
      style.gradients = gradients;

      if (fillStyleType === 0x13) {
        this.reader.readFIXED8();
      }
    } else if (
      fillStyleType === 0x40 ||
      fillStyleType === 0x41 ||
      fillStyleType === 0x42 ||
      fillStyleType === 0x43
    ) {
      // Bitmap fill
      style.type = 'bitmap';
      style.bitmapId = this.reader.readUI16();
      style.bitmapMatrix = this.reader.readMatrix();
      style.repeat = fillStyleType === 0x40 || fillStyleType === 0x42;
    }

    return style;
  }

  private parseFillStyleArray(tagCode: number): SwfFillStyle[] {
    let count = this.reader.readUI8();
    if (tagCode >= 22 && count === 0xff) {
      count = this.reader.readUI16();
    }

    const styles: SwfFillStyle[] = [];
    for (let i = 0; i < count; i++) {
      styles.push(this.parseSingleFillStyle(tagCode));
    }

    return styles;
  }

  private parseLineStyleArray(tagCode: number): SwfLineStyle[] {
    let count = this.reader.readUI8();
    if (tagCode >= 22 && count === 0xff) {
      count = this.reader.readUI16();
    }

    const styles: SwfLineStyle[] = [];
    const hasAlpha = tagCode === 32 || tagCode === 83 || tagCode === 46 || tagCode === 84;

    for (let i = 0; i < count; i++) {
      if (tagCode === 83 || tagCode === 84) {
        // LineStyle2 in DefineShape4 / DefineMorphShape2
        const rawWidth = this.reader.readUI16();
        const width = rawWidth === 0 ? 0.75 : rawWidth / 20.0;
        this.reader.readUB(2); // StartCapStyle
        const joinStyle = this.reader.readUB(2);
        const hasFill = this.reader.readUB(1) === 1;
        this.reader.readUB(1); // NoHScaleFlag
        this.reader.readUB(1); // NoVScaleFlag
        this.reader.readUB(1); // PixelHintingFlag
        this.reader.readUB(5); // Reserved
        this.reader.readUB(1); // NoClose
        this.reader.readUB(2); // EndCapStyle
        this.reader.alignByte();

        if (joinStyle === 2) {
          this.reader.readUI16(); // MiterLimitFactor
        }

        if (hasFill) {
          const singleFill = this.parseSingleFillStyle(tagCode);
          const clr = singleFill.color || { r: 0, g: 0, b: 0, a: 1 };
          styles.push({ width, color: clr });
        } else {
          const color = this.reader.readRGBA();
          styles.push({ width, color });
        }
      } else {
        const rawWidth = this.reader.readUI16();
        const width = rawWidth === 0 ? 0.75 : rawWidth / 20.0;
        const color = hasAlpha ? this.reader.readRGBA() : this.reader.readRGB();
        styles.push({ width, color });
      }
    }

    return styles;
  }

  private parseDefineMorphShape(tagCode: number, tagInfo: SwfTagInfo): void {
    const shapeId = this.reader.readUI16();
    tagInfo.characterId = shapeId;

    const startBounds = this.reader.readRect();
    const endBounds = this.reader.readRect();

    if (tagCode === 84) {
      this.reader.readRect(); // startEdgeBounds
      this.reader.readRect(); // endEdgeBounds
      this.reader.readUB(6); // reserved
      this.reader.readUB(1); // usesNonScalingStrokes
      this.reader.readUB(1); // usesScalingStrokes
      this.reader.alignByte();
    }

    const offset = this.reader.readUI32(); // offset to EndEdges
    const offsetEndPos = this.reader.pos;

    // Parse MorphFillStyles
    let fillCount = this.reader.readUI8();
    if (fillCount === 0xff) {
      fillCount = this.reader.readUI16();
    }
    const morphFillStyles: SwfMorphFillStyle[] = [];
    const fallbackFillStyles: SwfFillStyle[] = [];

    for (let i = 0; i < fillCount; i++) {
      const fillType = this.reader.readUI8();
      const morphStyle: SwfMorphFillStyle = { type: 'solid' };
      const fallbackStyle: SwfFillStyle = { type: 'solid' };

      if (fillType === 0x00) {
        const startColor = this.reader.readRGBA();
        const endColor = this.reader.readRGBA();
        morphStyle.type = 'solid';
        morphStyle.startColor = startColor;
        morphStyle.endColor = endColor;
        fallbackStyle.type = 'solid';
        fallbackStyle.color = startColor;
      } else if (fillType === 0x10 || fillType === 0x12) {
        morphStyle.type = fillType === 0x10 ? 'linearGradient' : 'radialGradient';
        fallbackStyle.type = morphStyle.type;
        const startMatrix = this.reader.readMatrix();
        const endMatrix = this.reader.readMatrix();
        morphStyle.startGradientMatrix = startMatrix;
        morphStyle.endGradientMatrix = endMatrix;
        fallbackStyle.gradientMatrix = startMatrix;

        const numGrads = this.reader.readUI8();
        const startGradients: SwfGradientRecord[] = [];
        const endGradients: SwfGradientRecord[] = [];

        for (let g = 0; g < numGrads; g++) {
          const startRatio = this.reader.readUI8();
          const startColor = this.reader.readRGBA();
          const endRatio = this.reader.readUI8();
          const endColor = this.reader.readRGBA();
          startGradients.push({ ratio: startRatio, color: startColor });
          endGradients.push({ ratio: endRatio, color: endColor });
        }
        morphStyle.startGradients = startGradients;
        morphStyle.endGradients = endGradients;
        fallbackStyle.gradients = startGradients;
      } else if (fillType === 0x40 || fillType === 0x41 || fillType === 0x42 || fillType === 0x43) {
        morphStyle.type = 'bitmap';
        fallbackStyle.type = 'bitmap';
        const bitmapId = this.reader.readUI16();
        const startBitmapMatrix = this.reader.readMatrix();
        const endBitmapMatrix = this.reader.readMatrix();
        const repeat = fillType === 0x40 || fillType === 0x42;
        morphStyle.bitmapId = bitmapId;
        morphStyle.startBitmapMatrix = startBitmapMatrix;
        morphStyle.endBitmapMatrix = endBitmapMatrix;
        morphStyle.repeat = repeat;
        fallbackStyle.bitmapId = bitmapId;
        fallbackStyle.bitmapMatrix = startBitmapMatrix;
        fallbackStyle.repeat = repeat;
      }

      morphFillStyles.push(morphStyle);
      fallbackFillStyles.push(fallbackStyle);
    }

    // Parse MorphLineStyles
    let lineCount = this.reader.readUI8();
    if (lineCount === 0xff) {
      lineCount = this.reader.readUI16();
    }
    const morphLineStyles: SwfMorphLineStyle[] = [];
    const fallbackLineStyles: SwfLineStyle[] = [];

    for (let i = 0; i < lineCount; i++) {
      if (tagCode === 84) {
        const rawStartWidth = this.reader.readUI16();
        const rawEndWidth = this.reader.readUI16();
        const startWidth = rawStartWidth === 0 ? 0.75 : rawStartWidth / 20.0;
        const endWidth = rawEndWidth === 0 ? 0.75 : rawEndWidth / 20.0;
        this.reader.readUB(2); // startCapStyle
        const joinStyle = this.reader.readUB(2);
        const hasFill = this.reader.readUB(1) === 1;
        this.reader.readUB(1);
        this.reader.readUB(1);
        this.reader.readUB(1);
        this.reader.readUB(5);
        this.reader.readUB(1);
        this.reader.readUB(2);
        this.reader.alignByte();
        if (joinStyle === 2) {
          this.reader.readUI16();
        }
        if (hasFill) {
          const singleFill = this.parseSingleFillStyle(tagCode);
          const clr = singleFill.color || { r: 0, g: 0, b: 0, a: 1 };
          morphLineStyles.push({ startWidth, endWidth, startColor: clr, endColor: clr });
          fallbackLineStyles.push({ width: startWidth, color: clr });
        } else {
          const startColor = this.reader.readRGBA();
          const endColor = this.reader.readRGBA();
          morphLineStyles.push({ startWidth, endWidth, startColor, endColor });
          fallbackLineStyles.push({ width: startWidth, color: startColor });
        }
      } else {
        const rawStartWidth = this.reader.readUI16();
        const rawEndWidth = this.reader.readUI16();
        const startWidth = rawStartWidth === 0 ? 0.75 : rawStartWidth / 20.0;
        const endWidth = rawEndWidth === 0 ? 0.75 : rawEndWidth / 20.0;
        const startColor = this.reader.readRGBA();
        const endColor = this.reader.readRGBA();
        morphLineStyles.push({ startWidth, endWidth, startColor, endColor });
        fallbackLineStyles.push({ width: startWidth, color: startColor });
      }
    }

    // Parse StartEdges and EndEdges in tandem
    const { startPaths, endPaths, morphEdges } = this.parseMorphShapeRecords(
      fallbackFillStyles,
      fallbackLineStyles,
      tagCode,
      offsetEndPos,
      offset,
      tagInfo
    );

    const morphShape: SwfMorphShape = {
      id: shapeId,
      startBounds,
      endBounds,
      fillStyles: morphFillStyles,
      lineStyles: morphLineStyles,
      startPaths,
      endPaths,
      morphEdges,
    };

    this.morphShapes.set(shapeId, morphShape);

    const shape: SwfShape = {
      id: shapeId,
      bounds: startBounds,
      fillStyles: fallbackFillStyles,
      lineStyles: fallbackLineStyles,
      paths: startPaths,
    };

    this.shapes.set(shapeId, shape);
    tagInfo.summary = `MorphShape ID ${shapeId} (${Math.round(startBounds.width)}x${Math.round(startBounds.height)}px, ${startPaths.length} paths, ${morphEdges.length} morph edges)`;
  }

  private parseMorphShapeRecords(
    fillStyles: SwfFillStyle[],
    lineStyles: SwfLineStyle[],
    tagCode: number,
    offsetEndPos: number,
    offset: number,
    tagInfo: SwfTagInfo
  ): { startPaths: SwfShapePath[]; endPaths: SwfShapePath[]; morphEdges: SwfMorphEdge[] } {
    const maxTagPos = this.rawBytes.length;
    let endEdgesPos = offsetEndPos + offset;
    if (endEdgesPos <= offsetEndPos || endEdgesPos >= maxTagPos) {
      endEdgesPos = this.reader.pos;
    }

    const startReader = this.reader;
    const endReader = new BitReader(this.rawBytes, endEdgesPos);

    // 1. Parse StartEdges
    interface ParsedMorphEdgePartial {
      x0: number;
      y0: number;
      cx: number;
      cy: number;
      x1: number;
      y1: number;
      isCurve: boolean;
      isNewSubpath: boolean;
      fillStyle0: number;
      fillStyle1: number;
      lineStyle: number;
    }

    const numFillBits = startReader.readUB(4);
    const numLineBits = startReader.readUB(4);
    let curX = 0;
    let curY = 0;
    let fillStyle0 = 0;
    let fillStyle1 = 0;
    let lineStyle = 0;
    let isNewSubpath = true;
    const startEdgesList: ParsedMorphEdgePartial[] = [];

    let iterations = 0;
    const maxIterations = 100000;

    while (iterations++ < maxIterations && !startReader.eof) {
      if (startReader.pos >= endEdgesPos) {
        break;
      }

      const typeFlag = startReader.readUB(1);
      if (typeFlag === 0) {
        const stateNewStyles = tagCode >= 22 ? startReader.readUB(1) === 1 : false;
        const stateLineStyle = startReader.readUB(1) === 1;
        const stateFillStyle1 = startReader.readUB(1) === 1;
        const stateFillStyle0 = startReader.readUB(1) === 1;
        const stateMoveTo = startReader.readUB(1) === 1;

        if (!stateNewStyles && !stateLineStyle && !stateFillStyle1 && !stateFillStyle0 && !stateMoveTo) {
          // EndShapeRecord
          break;
        }

        if (stateMoveTo) {
          const moveBits = startReader.readUB(5);
          curX = startReader.readSB(moveBits);
          curY = startReader.readSB(moveBits);
          isNewSubpath = true;
        }

        if (stateFillStyle0 && numFillBits > 0) {
          fillStyle0 = startReader.readUB(numFillBits);
        }
        if (stateFillStyle1 && numFillBits > 0) {
          fillStyle1 = startReader.readUB(numFillBits);
        }
        if (stateLineStyle && numLineBits > 0) {
          lineStyle = startReader.readUB(numLineBits);
        }
      } else {
        const straightFlag = startReader.readUB(1);
        const numBits = startReader.readUB(4) + 2;
        const x0 = curX / 20.0;
        const y0 = curY / 20.0;
        let cx = x0;
        let cy = y0;
        let x1 = x0;
        let y1 = y0;
        let isCurve = false;

        if (straightFlag === 1) {
          const generalLineFlag = startReader.readUB(1);
          let dx = 0;
          let dy = 0;
          if (generalLineFlag === 1) {
            dx = startReader.readSB(numBits);
            dy = startReader.readSB(numBits);
          } else {
            const vertFlag = startReader.readUB(1);
            if (vertFlag === 1) dy = startReader.readSB(numBits);
            else dx = startReader.readSB(numBits);
          }
          curX += dx;
          curY += dy;
          x1 = curX / 20.0;
          y1 = curY / 20.0;
          cx = (x0 + x1) / 2.0;
          cy = (y0 + y1) / 2.0;
          isCurve = false;
        } else {
          const controlDeltaX = startReader.readSB(numBits);
          const controlDeltaY = startReader.readSB(numBits);
          const anchorDeltaX = startReader.readSB(numBits);
          const anchorDeltaY = startReader.readSB(numBits);

          cx = (curX + controlDeltaX) / 20.0;
          cy = (curY + controlDeltaY) / 20.0;
          curX += controlDeltaX + anchorDeltaX;
          curY += controlDeltaY + anchorDeltaY;
          x1 = curX / 20.0;
          y1 = curY / 20.0;
          isCurve = true;
        }

        startEdgesList.push({
          x0,
          y0,
          cx,
          cy,
          x1,
          y1,
          isCurve,
          isNewSubpath,
          fillStyle0,
          fillStyle1,
          lineStyle,
        });
        isNewSubpath = false;
      }
    }

    // 2. Parse EndEdges
    interface EndParsedEdgePartial {
      x0: number;
      y0: number;
      cx: number;
      cy: number;
      x1: number;
      y1: number;
      isCurve: boolean;
      isNewSubpath: boolean;
    }

    const endNumFillBits = endReader.readUB(4);
    const endNumLineBits = endReader.readUB(4);
    let eCurX = 0;
    let eCurY = 0;
    let eIsNewSubpath = true;
    const endEdgesList: EndParsedEdgePartial[] = [];

    iterations = 0;
    while (iterations++ < maxIterations && !endReader.eof) {
      if (endReader.pos >= maxTagPos) {
        break;
      }

      const typeFlag = endReader.readUB(1);
      if (typeFlag === 0) {
        const stateNewStyles = endReader.readUB(1) === 1;
        const stateLineStyle = endReader.readUB(1) === 1;
        const stateFillStyle1 = endReader.readUB(1) === 1;
        const stateFillStyle0 = endReader.readUB(1) === 1;
        const stateMoveTo = endReader.readUB(1) === 1;

        if (!stateNewStyles && !stateLineStyle && !stateFillStyle1 && !stateFillStyle0 && !stateMoveTo) {
          // EndShapeRecord
          break;
        }

        if (stateMoveTo) {
          const moveBits = endReader.readUB(5);
          eCurX = endReader.readSB(moveBits);
          eCurY = endReader.readSB(moveBits);
          eIsNewSubpath = true;
        }

        if (stateFillStyle0 && endNumFillBits > 0) {
          endReader.readUB(endNumFillBits);
        }
        if (stateFillStyle1 && endNumFillBits > 0) {
          endReader.readUB(endNumFillBits);
        }
        if (stateLineStyle && endNumLineBits > 0) {
          endReader.readUB(endNumLineBits);
        }
      } else {
        const straightFlag = endReader.readUB(1);
        const numBits = endReader.readUB(4) + 2;
        const x0 = eCurX / 20.0;
        const y0 = eCurY / 20.0;
        let cx = x0;
        let cy = y0;
        let x1 = x0;
        let y1 = y0;
        let isCurve = false;

        if (straightFlag === 1) {
          const generalLineFlag = endReader.readUB(1);
          let dx = 0;
          let dy = 0;
          if (generalLineFlag === 1) {
            dx = endReader.readSB(numBits);
            dy = endReader.readSB(numBits);
          } else {
            const vertFlag = endReader.readUB(1);
            if (vertFlag === 1) dy = endReader.readSB(numBits);
            else dx = endReader.readSB(numBits);
          }
          eCurX += dx;
          eCurY += dy;
          x1 = eCurX / 20.0;
          y1 = eCurY / 20.0;
          cx = (x0 + x1) / 2.0;
          cy = (y0 + y1) / 2.0;
          isCurve = false;
        } else {
          const controlDeltaX = endReader.readSB(numBits);
          const controlDeltaY = endReader.readSB(numBits);
          const anchorDeltaX = endReader.readSB(numBits);
          const anchorDeltaY = endReader.readSB(numBits);

          cx = (eCurX + controlDeltaX) / 20.0;
          cy = (eCurY + controlDeltaY) / 20.0;
          eCurX += controlDeltaX + anchorDeltaX;
          eCurY += controlDeltaY + anchorDeltaY;
          x1 = eCurX / 20.0;
          y1 = eCurY / 20.0;
          isCurve = true;
        }

        endEdgesList.push({
          x0,
          y0,
          cx,
          cy,
          x1,
          y1,
          isCurve,
          isNewSubpath: eIsNewSubpath,
        });
        eIsNewSubpath = false;
      }
    }

    // 3. Match StartEdges and EndEdges 1-to-1
    const totalCount = Math.max(startEdgesList.length, endEdgesList.length);
    const morphEdges: SwfMorphEdge[] = [];

    for (let i = 0; i < totalCount; i++) {
      const s =
        startEdgesList[i] ||
        (startEdgesList.length > 0
          ? {
              x0: startEdgesList[startEdgesList.length - 1].x1,
              y0: startEdgesList[startEdgesList.length - 1].y1,
              cx: startEdgesList[startEdgesList.length - 1].x1,
              cy: startEdgesList[startEdgesList.length - 1].y1,
              x1: startEdgesList[startEdgesList.length - 1].x1,
              y1: startEdgesList[startEdgesList.length - 1].y1,
              isCurve: false,
              isNewSubpath: false,
              fillStyle0: startEdgesList[startEdgesList.length - 1].fillStyle0,
              fillStyle1: startEdgesList[startEdgesList.length - 1].fillStyle1,
              lineStyle: startEdgesList[startEdgesList.length - 1].lineStyle,
            }
          : {
              x0: 0,
              y0: 0,
              cx: 0,
              cy: 0,
              x1: 0,
              y1: 0,
              isCurve: false,
              isNewSubpath: false,
              fillStyle0: 0,
              fillStyle1: 0,
              lineStyle: 0,
            });

      const e =
        endEdgesList[i] ||
        (endEdgesList.length > 0
          ? {
              x0: endEdgesList[endEdgesList.length - 1].x1,
              y0: endEdgesList[endEdgesList.length - 1].y1,
              cx: endEdgesList[endEdgesList.length - 1].x1,
              cy: endEdgesList[endEdgesList.length - 1].y1,
              x1: endEdgesList[endEdgesList.length - 1].x1,
              y1: endEdgesList[endEdgesList.length - 1].y1,
              isCurve: false,
              isNewSubpath: false,
            }
          : {
              x0: s.x0,
              y0: s.y0,
              cx: s.cx,
              cy: s.cy,
              x1: s.x1,
              y1: s.y1,
              isCurve: s.isCurve,
              isNewSubpath: s.isNewSubpath,
            });

      morphEdges.push({
        startX0: s.x0,
        startY0: s.y0,
        startCX: s.cx,
        startCY: s.cy,
        startX1: s.x1,
        startY1: s.y1,
        startIsCurve: s.isCurve,

        endX0: e.x0,
        endY0: e.y0,
        endCX: e.cx,
        endCY: e.cy,
        endX1: e.x1,
        endY1: e.y1,
        endIsCurve: e.isCurve,

        isNewSubpath: s.isNewSubpath || e.isNewSubpath || i === 0,

        fillStyle0: s.fillStyle0,
        fillStyle1: s.fillStyle1,
        lineStyle: s.lineStyle,
      });
    }

    const startPaths = buildPathsFromMorphEdges(morphEdges, 0);
    const endPaths = buildPathsFromMorphEdges(morphEdges, 1);

    return { startPaths, endPaths, morphEdges };
  }

  private parseShapeRecords(
    fillStyles: SwfFillStyle[],
    lineStyles: SwfLineStyle[],
    tagCode: number
  ): SwfShapePath[] {
    let numFillBits = this.reader.readUB(4);
    let numLineBits = this.reader.readUB(4);

    const paths: SwfShapePath[] = [];
    let currentPath: SwfShapePath = {
      fillStyle0: 0,
      fillStyle1: 0,
      lineStyle: 0,
      commands: [],
    };

    let curX = 0;
    let curY = 0;

    let iterations = 0;
    const maxIterations = 100000;

    while (iterations++ < maxIterations) {
      const typeFlag = this.reader.readUB(1);

      if (typeFlag === 0) {
        // StyleChangeRecord or EndShapeRecord
        const stateNewStyles = this.reader.readUB(1) === 1;
        const stateLineStyle = this.reader.readUB(1) === 1;
        const stateFillStyle1 = this.reader.readUB(1) === 1;
        const stateFillStyle0 = this.reader.readUB(1) === 1;
        const stateMoveTo = this.reader.readUB(1) === 1;

        if (
          !stateNewStyles &&
          !stateLineStyle &&
          !stateFillStyle1 &&
          !stateFillStyle0 &&
          !stateMoveTo
        ) {
          // EndShapeRecord
          break;
        }

        // Finalize previous path if it has commands
        if (currentPath.commands.length > 0) {
          paths.push(currentPath);
          currentPath = {
            fillStyle0: currentPath.fillStyle0,
            fillStyle1: currentPath.fillStyle1,
            lineStyle: currentPath.lineStyle,
            commands: [],
          };
        }

        if (stateMoveTo) {
          const moveBits = this.reader.readUB(5);
          const dx = this.reader.readSB(moveBits);
          const dy = this.reader.readSB(moveBits);

          curX = dx;
          curY = dy;

          currentPath.commands.push({
            type: 'moveTo',
            x: curX / 20.0,
            y: curY / 20.0,
          });
        }

        if (stateFillStyle0) {
          currentPath.fillStyle0 = this.reader.readUB(numFillBits);
        }
        if (stateFillStyle1) {
          currentPath.fillStyle1 = this.reader.readUB(numFillBits);
        }
        if (stateLineStyle) {
          currentPath.lineStyle = this.reader.readUB(numLineBits);
        }

        if (stateNewStyles) {
          const newFills = this.parseFillStyleArray(tagCode);
          const newLines = this.parseLineStyleArray(tagCode);
          fillStyles.push(...newFills);
          lineStyles.push(...newLines);
          numFillBits = this.reader.readUB(4);
          numLineBits = this.reader.readUB(4);
        }
      } else {
        // EdgeRecord
        const straightFlag = this.reader.readUB(1);
        const numBits = this.reader.readUB(4) + 2;

        // Ensure path starts at curX, curY
        if (currentPath.commands.length === 0) {
          currentPath.commands.push({
            type: 'moveTo',
            x: curX / 20.0,
            y: curY / 20.0,
          });
        }

        if (straightFlag === 1) {
          // StraightEdgeRecord
          const generalLineFlag = this.reader.readUB(1);
          let dx = 0;
          let dy = 0;
          if (generalLineFlag === 1) {
            dx = this.reader.readSB(numBits);
            dy = this.reader.readSB(numBits);
          } else {
            const vertFlag = this.reader.readUB(1);
            if (vertFlag === 1) {
              dy = this.reader.readSB(numBits);
            } else {
              dx = this.reader.readSB(numBits);
            }
          }
          curX += dx;
          curY += dy;
          currentPath.commands.push({
            type: 'lineTo',
            x: curX / 20.0,
            y: curY / 20.0,
          });
        } else {
          // CurvedEdgeRecord (quadratic bezier)
          const controlDeltaX = this.reader.readSB(numBits);
          const controlDeltaY = this.reader.readSB(numBits);
          const anchorDeltaX = this.reader.readSB(numBits);
          const anchorDeltaY = this.reader.readSB(numBits);

          const cx = curX + controlDeltaX;
          const cy = curY + controlDeltaY;
          const ax = cx + anchorDeltaX;
          const ay = cy + anchorDeltaY;

          curX = ax;
          curY = ay;

          currentPath.commands.push({
            type: 'curveTo',
            cx: cx / 20.0,
            cy: cy / 20.0,
            ax: ax / 20.0,
            ay: ay / 20.0,
          });
        }
      }
    }

    if (currentPath.commands.length > 0) {
      paths.push(currentPath);
    }

    return paths;
  }

  private parsePlaceObject(
    frame: SwfFrame,
    activeDisplayList: Map<number, SwfDisplayObject>,
    tagInfo: SwfTagInfo
  ): void {
    const characterId = this.reader.readUI16();
    const depth = this.reader.readUI16();
    const matrix = this.reader.readMatrix();
    let colorTransform;
    if (this.reader.remaining > 0) {
      colorTransform = this.reader.readColorTransform(false);
    }

    const obj: SwfDisplayObject = {
      characterId,
      depth,
      matrix,
      colorTransform,
    };
    frame.placedObjects.push(obj);
    activeDisplayList.set(depth, obj);
    tagInfo.characterId = characterId;
    tagInfo.summary = `Place ID ${characterId} at depth ${depth}`;
  }

  private parsePlaceObject2(
    frame: SwfFrame,
    activeDisplayList: Map<number, SwfDisplayObject>,
    tagInfo: SwfTagInfo,
    isPlace3 = false
  ): void {
    let placeFlags = this.reader.readUI8();
    let placeFlags2 = 0;
    if (isPlace3) {
      placeFlags2 = this.reader.readUI8();
    }

    const hasClipActions = (placeFlags & 0x80) !== 0;
    const hasClipDepth = (placeFlags & 0x40) !== 0;
    const hasName = (placeFlags & 0x20) !== 0;
    const hasRatio = (placeFlags & 0x10) !== 0;
    const hasColorTransform = (placeFlags & 0x08) !== 0;
    const hasMatrix = (placeFlags & 0x04) !== 0;
    const hasCharacter = (placeFlags & 0x02) !== 0;
    const isMove = (placeFlags & 0x01) !== 0;

    const depth = this.reader.readUI16();
    const existing = activeDisplayList.get(depth);

    let characterId = 0;
    if (hasCharacter) {
      characterId = this.reader.readUI16();
      tagInfo.characterId = characterId;
    } else if (existing) {
      characterId = existing.characterId;
    }

    let matrix: SwfMatrix;
    if (hasMatrix) {
      matrix = this.reader.readMatrix();
    } else if (existing) {
      matrix = existing.matrix;
    } else {
      matrix = {
        hasScale: false,
        scaleX: 1,
        scaleY: 1,
        hasRotate: false,
        rotateSkew0: 0,
        rotateSkew1: 0,
        translateX: 0,
        translateY: 0,
      };
    }

    let colorTransform;
    if (hasColorTransform) {
      colorTransform = this.reader.readColorTransform(true);
    } else if (existing) {
      colorTransform = existing.colorTransform;
    }

    let ratio;
    if (hasRatio) {
      ratio = this.reader.readUI16();
    } else if (existing) {
      ratio = existing.ratio;
    }

    let name;
    if (hasName) {
      name = this.reader.readString();
    } else if (existing) {
      name = existing.name;
    }

    let clipDepth;
    if (hasClipDepth) {
      clipDepth = this.reader.readUI16();
    } else if (existing) {
      clipDepth = existing.clipDepth;
    }

    if (isPlace3) {
      const hasFilterList = (placeFlags2 & 0x01) !== 0;
      const hasBlendMode = (placeFlags2 & 0x02) !== 0;
      const hasVisible = (placeFlags2 & 0x20) !== 0;
      const hasOpaqueBackground = (placeFlags2 & 0x40) !== 0;

      if (hasFilterList) {
        // Read filter list
        const numFilters = this.reader.readUI8();
        for (let f = 0; f < numFilters; f++) {
          const filterId = this.reader.readUI8();
          // Skip filter bytes based on standard filter types if needed
          if (filterId === 0 || filterId === 1 || filterId === 2 || filterId === 3 || filterId === 4 || filterId === 7) {
            this.reader.readRGBA();
            this.reader.readFIXED8();
            this.reader.readFIXED8();
            this.reader.readFIXED8();
            this.reader.readFIXED8();
            this.reader.readUI8();
          }
        }
      }
      if (hasBlendMode) {
        this.reader.readUI8();
      }
      if (hasVisible) {
        this.reader.readUI8();
      }
      if (hasOpaqueBackground) {
        this.reader.readRGBA();
      }
    }

    const obj: SwfDisplayObject = {
      depth,
      characterId,
      matrix,
      colorTransform,
      ratio,
      name,
      clipDepth,
    };

    activeDisplayList.set(depth, obj);
    frame.placedObjects.push(obj);
    tagInfo.summary = `Depth ${depth}${characterId ? ` (ID ${characterId})` : ''}${name ? ` "${name}"` : ''}${isMove ? ' [Move]' : ''}`;
  }

  private parseRemoveObject(
    frame: SwfFrame,
    activeDisplayList: Map<number, SwfDisplayObject>,
    tagInfo: SwfTagInfo,
    isRemove2 = false
  ): void {
    let characterId = 0;
    if (!isRemove2) {
      characterId = this.reader.readUI16();
    }
    const depth = this.reader.readUI16();
    frame.removedDepths.push(depth);
    activeDisplayList.delete(depth);
    tagInfo.summary = `Remove depth ${depth}${characterId ? ` (ID ${characterId})` : ''}`;
  }

  private parseDefineBitsJPEG(tagCode: number, tagLength: number, tagInfo: SwfTagInfo): void {
    const characterId = this.reader.readUI16();
    tagInfo.characterId = characterId;

    let imgData: Uint8Array;
    let alphaData: Uint8Array | null = null;

    if (tagCode === 6) {
      // DefineBits (uses global JPEGTables)
      const rawJpeg = this.reader.readBytes(tagLength - 2);
      if (this.jpegTables && this.jpegTables.length > 0) {
        // Concatenate JPEGTables (without EOI 0xFF,0xD9) and rawJpeg (without SOI 0xFF,0xD8)
        let tablesEnd = this.jpegTables.length;
        if (
          tablesEnd >= 2 &&
          this.jpegTables[tablesEnd - 2] === 0xff &&
          this.jpegTables[tablesEnd - 1] === 0xd9
        ) {
          tablesEnd -= 2;
        }

        let jpegStart = 0;
        if (rawJpeg.length >= 2 && rawJpeg[0] === 0xff && rawJpeg[1] === 0xd8) {
          jpegStart = 2;
        }

        const combined = new Uint8Array(tablesEnd + (rawJpeg.length - jpegStart));
        combined.set(this.jpegTables.subarray(0, tablesEnd), 0);
        combined.set(rawJpeg.subarray(jpegStart), tablesEnd);
        imgData = combined;
      } else {
        imgData = rawJpeg;
      }
    } else if (tagCode === 21) {
      // DefineBitsJPEG2 (standalone JPEG, PNG, or GIF)
      imgData = this.reader.readBytes(tagLength - 2);
    } else if (tagCode === 35 || tagCode === 90) {
      // DefineBitsJPEG3 / DefineBitsJPEG4 (JPEG with alpha channel)
      let offset = 2;
      if (tagCode === 90) {
        this.reader.readUI16(); // deblockParam
        offset += 2;
      }
      const alphaOffset = this.reader.readUI32();
      imgData = this.reader.readBytes(alphaOffset);
      const remainingAlpha = tagLength - offset - 4 - alphaOffset;
      if (remainingAlpha > 0) {
        alphaData = this.reader.readBytes(remainingAlpha);
      }
    } else {
      imgData = this.reader.readBytes(tagLength - 2);
    }

    // Determine MIME type and clean JPEG header artifact (0xFF 0xD9 0xFF 0xD8)
    let mimeType = 'image/jpeg';
    if (
      imgData.length >= 8 &&
      imgData[0] === 0x89 &&
      imgData[1] === 0x50 &&
      imgData[2] === 0x4e &&
      imgData[3] === 0x47
    ) {
      mimeType = 'image/png';
    } else if (
      imgData.length >= 3 &&
      imgData[0] === 0x47 &&
      imgData[1] === 0x49 &&
      imgData[2] === 0x46
    ) {
      mimeType = 'image/gif';
    } else {
      // Fix SWF JPEG internal EOI/SOI sequence
      for (let i = 0; i < imgData.length - 3; i++) {
        if (
          imgData[i] === 0xff &&
          imgData[i + 1] === 0xd9 &&
          imgData[i + 2] === 0xff &&
          imgData[i + 3] === 0xd8
        ) {
          const cleaned = new Uint8Array(imgData.length - 4);
          cleaned.set(imgData.subarray(0, i), 0);
          cleaned.set(imgData.subarray(i + 4), i);
          imgData = cleaned;
          break;
        }
      }
    }

    let dataUrl = '';
    try {
      const blob = new Blob([imgData.buffer as ArrayBuffer], { type: mimeType });
      dataUrl = URL.createObjectURL(blob);
    } catch {
      // ignore
    }

    const bitmap: SwfBitmap = {
      id: characterId,
      format: 'jpeg',
      width: 0,
      height: 0,
      dataUrl,
      rawBytes: imgData,
      mimeType,
      isLoaded: false,
    };

    if (dataUrl) {
      const img = new Image();
      img.src = dataUrl;
      img.onload = () => {
        bitmap.width = img.naturalWidth;
        bitmap.height = img.naturalHeight;
        bitmap.isLoaded = true;

        if (alphaData && alphaData.length > 0) {
          try {
            const unzippedAlpha = unzlibSync(alphaData);
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d');
            if (ctx && img.naturalWidth > 0 && img.naturalHeight > 0) {
              ctx.drawImage(img, 0, 0);
              const imgDataObj = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const px = imgDataObj.data;
              const len = Math.min(unzippedAlpha.length, canvas.width * canvas.height);
              for (let i = 0; i < len; i++) {
                px[i * 4 + 3] = unzippedAlpha[i];
              }
              ctx.putImageData(imgDataObj, 0, 0);
              bitmap.canvasElement = canvas;
            }
          } catch {
            // keep standard image
          }
        } else {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d');
            if (ctx && img.naturalWidth > 0 && img.naturalHeight > 0) {
              ctx.drawImage(img, 0, 0);
              bitmap.canvasElement = canvas;
            }
          } catch {
            // keep standard image
          }
        }
      };
      bitmap.imageElement = img;
    }

    this.bitmaps.set(characterId, bitmap);
    tagInfo.summary = `${mimeType.toUpperCase()} Bitmap ID ${characterId} (${(imgData.length / 1024).toFixed(1)} KB)`;
  }

  private parseDefineBitsLossless(tagCode: number, tagLength: number, tagInfo: SwfTagInfo): void {
    const characterId = this.reader.readUI16();
    const bitmapFormat = this.reader.readUI8();
    const width = this.reader.readUI16();
    const height = this.reader.readUI16();
    tagInfo.characterId = characterId;

    let colorTableSize = 0;
    let headerOffset = 7;
    if (bitmapFormat === 3) {
      colorTableSize = this.reader.readUI8() + 1;
      headerOffset = 8;
    }

    const compressed = this.reader.readBytes(tagLength - headerOffset);
    let dataUrl = '';
    let canvasElement: HTMLCanvasElement | undefined;

    try {
      const unzipped = unzlibSync(compressed);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');

      if (ctx && width > 0 && height > 0) {
        const imgData = ctx.createImageData(width, height);
        const data = imgData.data;

        if (bitmapFormat === 3) {
          // Format 3: 8-bit Colormapped / Palette
          const isTag36 = tagCode === 36;
          const entrySize = isTag36 ? 4 : 3;
          const paletteData = unzipped.subarray(0, colorTableSize * entrySize);
          const pixelOffset = colorTableSize * entrySize;
          const rowStride = Math.floor((width + 3) / 4) * 4;

          let dstIdx = 0;
          for (let y = 0; y < height; y++) {
            const rowStart = pixelOffset + y * rowStride;
            for (let x = 0; x < width; x++) {
              const palIdx = unzipped[rowStart + x] || 0;
              const pOffset = palIdx * entrySize;
              if (pOffset + entrySize <= paletteData.length) {
                data[dstIdx] = paletteData[pOffset];
                data[dstIdx + 1] = paletteData[pOffset + 1];
                data[dstIdx + 2] = paletteData[pOffset + 2];
                data[dstIdx + 3] = isTag36 ? paletteData[pOffset + 3] : 255;
              }
              dstIdx += 4;
            }
          }
        } else if (bitmapFormat === 4) {
          // Format 4: 15-bit RGB
          const rowStride = Math.floor((width * 2 + 3) / 4) * 4;
          let dstIdx = 0;
          for (let y = 0; y < height; y++) {
            const rowStart = y * rowStride;
            for (let x = 0; x < width; x++) {
              const byteIdx = rowStart + x * 2;
              if (byteIdx + 1 < unzipped.length) {
                const val = (unzipped[byteIdx] << 8) | unzipped[byteIdx + 1];
                const r = ((val >> 10) & 0x1f) << 3;
                const g = ((val >> 5) & 0x1f) << 3;
                const b = (val & 0x1f) << 3;
                data[dstIdx] = r;
                data[dstIdx + 1] = g;
                data[dstIdx + 2] = b;
                data[dstIdx + 3] = 255;
              }
              dstIdx += 4;
            }
          }
        } else if (bitmapFormat === 5) {
          // Format 5: 24-bit RGB (Tag 20) or 32-bit ARGB (Tag 36)
          let srcIdx = 0;
          let dstIdx = 0;
          const isTag36 = tagCode === 36;

          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              if (srcIdx + 3 < unzipped.length) {
                const a = unzipped[srcIdx];
                let r = unzipped[srcIdx + 1];
                let g = unzipped[srcIdx + 2];
                let b = unzipped[srcIdx + 3];

                if (isTag36) {
                  // Un-premultiply alpha for canvas display
                  if (a > 0 && a < 255) {
                    r = Math.min(255, Math.round((r * 255) / a));
                    g = Math.min(255, Math.round((g * 255) / a));
                    b = Math.min(255, Math.round((b * 255) / a));
                  }
                  data[dstIdx] = r;
                  data[dstIdx + 1] = g;
                  data[dstIdx + 2] = b;
                  data[dstIdx + 3] = a;
                } else {
                  // Tag 20: [reserved, R, G, B]
                  data[dstIdx] = r;
                  data[dstIdx + 1] = g;
                  data[dstIdx + 2] = b;
                  data[dstIdx + 3] = 255;
                }
              }
              srcIdx += 4;
              dstIdx += 4;
            }
          }
        }

        ctx.putImageData(imgData, 0, 0);
        dataUrl = canvas.toDataURL('image/png');
        canvasElement = canvas;
      }
    } catch (e) {
      console.warn('Failed to parse lossless bitmap:', e);
    }

    const bitmap: SwfBitmap = {
      id: characterId,
      format: tagCode === 36 ? 'lossless2' : 'lossless',
      width,
      height,
      dataUrl,
      canvasElement,
      isLoaded: true,
      mimeType: 'image/png',
    };

    if (dataUrl) {
      const img = new Image();
      img.src = dataUrl;
      img.onload = () => {
        bitmap.imageElement = img;
        bitmap.isLoaded = true;
      };
      bitmap.imageElement = img;
    }

    this.bitmaps.set(characterId, bitmap);
    tagInfo.summary = `Lossless Bitmap ID ${characterId} (${width}x${height}px, format ${bitmapFormat})`;
  }

  private parseDoAction(frame: SwfFrame, tagLength: number, tagInfo: SwfTagInfo): void {
    const actions: SwfAction[] = [];
    const endPos = this.reader.pos + tagLength;

    while (this.reader.pos < endPos) {
      const actionCode = this.reader.readUI8();
      if (actionCode === 0) break;

      let actionLength = 0;
      if (actionCode >= 0x80) {
        actionLength = this.reader.readUI16();
      }

      const actionData = actionLength > 0 ? this.reader.readBytes(actionLength) : new Uint8Array(0);
      const actionName = this.getActionName(actionCode);
      const args = this.decodeActionArgs(actionCode, actionData);

      actions.push({
        code: actionCode,
        name: actionName,
        args,
      });
    }

    frame.actions.push(...actions);
    tagInfo.summary = `${actions.length} action(s): ${actions.map((a) => a.name).join(', ')}`;
  }

  private getActionName(code: number): string {
    const ACTION_NAMES: Record<number, string> = {
      0x04: 'NextFrame',
      0x05: 'PrevFrame',
      0x06: 'Play',
      0x07: 'Stop',
      0x08: 'ToggleQuality',
      0x09: 'StopSounds',
      0x0a: 'Add',
      0x0b: 'Subtract',
      0x0c: 'Multiply',
      0x0d: 'Divide',
      0x0e: 'Equals',
      0x0f: 'Less',
      0x10: 'And',
      0x11: 'Or',
      0x12: 'Not',
      0x13: 'StringEquals',
      0x14: 'StringLength',
      0x17: 'Pop',
      0x1c: 'GetVariable',
      0x1d: 'SetVariable',
      0x20: 'SetTarget2',
      0x21: 'StringAdd',
      0x26: 'Trace',
      0x34: 'GetTime',
      0x3d: 'CallFunction',
      0x3e: 'Return',
      0x81: 'GotoFrame',
      0x83: 'GetURL',
      0x88: 'ConstantPool',
      0x8a: 'WaitForFrame',
      0x8b: 'SetTarget',
      0x8c: 'GotoLabel',
      0x96: 'Push',
      0x99: 'BranchAlways',
      0x9d: 'BranchIfTrue',
    };
    return ACTION_NAMES[code] || `Action_0x${code.toString(16)}`;
  }

  private decodeActionArgs(code: number, data: Uint8Array): any {
    if (code === 0x81 && data.length >= 2) {
      return { frame: data[0] | (data[1] << 8) };
    }
    if (code === 0x8c) {
      return { label: new TextDecoder().decode(data.filter((b) => b !== 0)) };
    }
    if (code === 0x83) {
      const parts = new TextDecoder().decode(data).split('\0');
      return { url: parts[0], target: parts[1] };
    }
    if (code === 0x96) {
      const items: any[] = [];
      let i = 0;
      while (i < data.length) {
        const type = data[i++];
        if (type === 0) {
          const strBytes: number[] = [];
          while (i < data.length && data[i] !== 0) {
            strBytes.push(data[i++]);
          }
          i++;
          items.push(new TextDecoder().decode(new Uint8Array(strBytes)));
        } else if (type === 1) {
          if (i + 4 <= data.length) {
            const view = new DataView(data.buffer, data.byteOffset + i, 4);
            items.push(view.getFloat32(0, true));
            i += 4;
          }
        } else if (type === 2) {
          items.push(null);
        } else if (type === 3) {
          items.push(undefined);
        } else if (type === 4) {
          items.push(`r:${data[i++]}`);
        } else if (type === 5) {
          items.push(data[i++] !== 0);
        } else if (type === 6) {
          if (i + 8 <= data.length) {
            const view = new DataView(data.buffer, data.byteOffset + i, 8);
            items.push(view.getFloat64(0, true));
            i += 8;
          }
        } else if (type === 7) {
          if (i + 4 <= data.length) {
            const view = new DataView(data.buffer, data.byteOffset + i, 4);
            items.push(view.getInt32(0, true));
            i += 4;
          }
        } else if (type === 8) {
          items.push(`c[${data[i++]}]`);
        } else if (type === 9) {
          if (i + 2 <= data.length) {
            const idx = data[i] | (data[i + 1] << 8);
            items.push(`c[${idx}]`);
            i += 2;
          }
        }
      }
      return items;
    }
    return undefined;
  }

  private parseDefineSprite(tagInfo: SwfTagInfo): void {
    const spriteId = this.reader.readUI16();
    const frameCount = this.reader.readUI16();
    tagInfo.characterId = spriteId;

    const frames: SwfFrame[] = [];
    const activeSpriteDisplayList = new Map<number, SwfDisplayObject>();

    let curFrame: SwfFrame = {
      frameIndex: 0,
      actions: [],
      placedObjects: [],
      removedDepths: [],
      startSounds: [],
    };

    while (!this.reader.eof) {
      const subTagCodeAndLength = this.reader.readUI16();
      const subTagCode = subTagCodeAndLength >> 6;
      let subTagLength = subTagCodeAndLength & 0x3f;
      if (subTagLength === 0x3f) {
        subTagLength = this.reader.readUI32();
      }

      if (subTagCode === 0) {
        // End of sprite
        break;
      }

      const subEnd = this.reader.pos + subTagLength;

      if (subTagCode === 1) {
        // ShowFrame
        curFrame.displaySnapshot = this.cloneDisplayList(activeSpriteDisplayList);
        frames.push(curFrame);
        curFrame = {
          frameIndex: frames.length,
          actions: [],
          placedObjects: [],
          removedDepths: [],
          startSounds: [],
        };
      } else if (subTagCode === 4) {
        this.parsePlaceObject(curFrame, activeSpriteDisplayList, { code: subTagCode, name: '', offset: 0, length: 0 });
      } else if (subTagCode === 26 || subTagCode === 70) {
        this.parsePlaceObject2(curFrame, activeSpriteDisplayList, { code: subTagCode, name: '', offset: 0, length: 0 }, subTagCode === 70);
      } else if (subTagCode === 5 || subTagCode === 28) {
        this.parseRemoveObject(curFrame, activeSpriteDisplayList, { code: subTagCode, name: '', offset: 0, length: 0 }, subTagCode === 28);
      } else if (subTagCode === 12) {
        this.parseDoAction(curFrame, subTagLength, { code: subTagCode, name: '', offset: 0, length: 0 });
      } else if (subTagCode === 61) {
        this.parseVideoFrame(subTagLength, { code: subTagCode, name: 'VideoFrame', offset: 0, length: subTagLength });
      }

      this.reader.pos = subEnd;
      this.reader.bitPos = 0;
    }

    if (
      curFrame.placedObjects.length > 0 ||
      curFrame.actions.length > 0 ||
      activeSpriteDisplayList.size > 0
    ) {
      curFrame.displaySnapshot = this.cloneDisplayList(activeSpriteDisplayList);
      frames.push(curFrame);
    }

    // Ensure frame 0 has display snapshot even for 1-frame graphic symbols
    if (frames.length > 0 && !frames[0].displaySnapshot) {
      frames[0].displaySnapshot = this.cloneDisplayList(activeSpriteDisplayList);
    }

    const sprite: SwfSprite = {
      id: spriteId,
      frameCount: Math.max(1, frames.length || frameCount),
      frames,
    };

    this.sprites.set(spriteId, sprite);
    tagInfo.summary = `Sprite ID ${spriteId} (${frames.length} frame(s))`;
  }

  private parseDefineButton(tagCode: number, tagLength: number, tagInfo: SwfTagInfo): void {
    const buttonId = this.reader.readUI16();
    tagInfo.characterId = buttonId;

    const characters: SwfButtonRecord[] = [];
    const isButton2 = tagCode === 34;

    if (isButton2) {
      this.reader.readUI8();
      this.reader.readUI16();
    }

    while (!this.reader.eof) {
      const flags = this.reader.readUI8();
      if (flags === 0) break;

      const stateHitTest = (flags & 0x08) !== 0;
      const stateDown = (flags & 0x04) !== 0;
      const stateOver = (flags & 0x02) !== 0;
      const stateUp = (flags & 0x01) !== 0;

      const characterId = this.reader.readUI16();
      const depth = this.reader.readUI16();
      const matrix = this.reader.readMatrix();
      let colorTransform;
      if (isButton2) {
        colorTransform = this.reader.readColorTransform(true);
      }

      characters.push({
        stateHitTest,
        stateDown,
        stateOver,
        stateUp,
        characterId,
        depth,
        matrix,
        colorTransform,
      });
    }

    const button: SwfButton = {
      id: buttonId,
      characters,
    };
    this.buttons.set(buttonId, button);
    tagInfo.summary = `Button ID ${buttonId} (${characters.length} state record(s))`;
  }

  private parseDefineFont(tagCode: number, tagLength: number, tagInfo: SwfTagInfo): void {
    const fontId = this.reader.readUI16();
    tagInfo.characterId = fontId;

    if (tagCode === 48 || tagCode === 75) {
      // DefineFont2 / DefineFont3
      const flags = this.reader.readUI8();
      const hasLayout = (flags & 0x80) !== 0;
      const isShiftJIS = (flags & 0x40) !== 0;
      const isSmallText = (flags & 0x20) !== 0;
      const isANSI = (flags & 0x10) !== 0;
      const isWideOffsets = (flags & 0x08) !== 0;
      const isWideCodes = (flags & 0x04) !== 0;
      const isItalic = (flags & 0x02) !== 0;
      const isBold = (flags & 0x01) !== 0;

      const languageCode = this.reader.readUI8();
      const fontNameLen = this.reader.readUI8();
      const fontNameBytes = this.reader.readBytes(fontNameLen);
      const fontName = decodeSwfString(fontNameBytes);
      const fontIsShiftJIS = isShiftJIS || languageCode === 2;

      const numGlyphs = this.reader.readUI16();
      const codeTable: number[] = [];
      const glyphShapes: SwfShape[] = [];

      if (numGlyphs > 0) {
        const offsetTableStart = this.reader.pos;
        const offsets: number[] = [];
        for (let i = 0; i < numGlyphs; i++) {
          offsets.push(isWideOffsets ? this.reader.readUI32() : this.reader.readUI16());
        }
        const codeTableOffset = isWideOffsets ? this.reader.readUI32() : this.reader.readUI16();

        // 1. Read CodeTable using codeTableOffset
        const targetPos = offsetTableStart + codeTableOffset;
        if (targetPos < this.reader.bytes.length) {
          const savedPos = this.reader.pos;
          this.reader.pos = targetPos;
          this.reader.bitPos = 0;

          for (let i = 0; i < numGlyphs; i++) {
            if (isWideCodes || tagCode === 75) {
              codeTable.push(this.reader.readUI16());
            } else {
              codeTable.push(this.reader.readUI8());
            }
          }
          this.reader.pos = savedPos;
        }

        // 2. Parse GlyphShapeTable (vector shapes for each glyph)
        try {
          for (let i = 0; i < numGlyphs; i++) {
            const shapePos = offsetTableStart + offsets[i];
            if (shapePos < this.reader.bytes.length) {
              this.reader.pos = shapePos;
              this.reader.bitPos = 0;
              const paths = this.parseShapeRecords(
                [{ type: 'solid', color: { r: 255, g: 255, b: 255, a: 1 } }],
                [],
                tagCode
              );
              glyphShapes.push({
                id: i,
                bounds: { nbits: 0, xmin: 0, xmax: 1024, ymin: 0, ymax: 1024, width: 51.2, height: 51.2 },
                fillStyles: [{ type: 'solid' }],
                lineStyles: [],
                paths,
              });
            }
          }
        } catch {
          // Glyph shapes parsing fallback
        }
      }

      const existing = this.fonts.get(fontId);
      if (existing) {
        existing.tagCode = tagCode;
        existing.name = fontName || existing.name;
        existing.isBold = isBold || existing.isBold;
        existing.isItalic = isItalic || existing.isItalic;
        if (fontIsShiftJIS) existing.isShiftJIS = true;
        if (languageCode) existing.languageCode = languageCode;
        if (codeTable.length > 0) existing.codeTable = codeTable;
        if (glyphShapes.length > 0) existing.glyphShapes = glyphShapes;
      } else {
        this.fonts.set(fontId, {
          id: fontId,
          tagCode,
          name: fontName,
          isBold,
          isItalic,
          isShiftJIS: fontIsShiftJIS,
          languageCode,
          codeTable,
          glyphShapes,
        });
      }
      tagInfo.summary = `Font ID ${fontId} "${fontName}" (${numGlyphs} glyphs)`;
    } else {
      // Tag 10: DefineFont
      const glyphShapes: SwfShape[] = [];
      try {
        const offsetTableStart = this.reader.pos;
        const offset0 = this.reader.readUI16();
        const numGlyphs = Math.floor(offset0 / 2);
        const offsets: number[] = [offset0];
        for (let i = 1; i < numGlyphs; i++) {
          offsets.push(this.reader.readUI16());
        }

        for (let i = 0; i < numGlyphs; i++) {
          const shapePos = offsetTableStart + offsets[i];
          if (shapePos < this.reader.bytes.length) {
            this.reader.pos = shapePos;
            this.reader.bitPos = 0;
            const paths = this.parseShapeRecords(
              [{ type: 'solid', color: { r: 255, g: 255, b: 255, a: 1 } }],
              [],
              tagCode
            );
            glyphShapes.push({
              id: i,
              bounds: { nbits: 0, xmin: 0, xmax: 1024, ymin: 0, ymax: 1024, width: 51.2, height: 51.2 },
              fillStyles: [{ type: 'solid' }],
              lineStyles: [],
              paths,
            });
          }
        }
      } catch {
        // Continue
      }

      const existing = this.fonts.get(fontId);
      if (existing) {
        existing.tagCode = tagCode;
        if (glyphShapes.length > 0) existing.glyphShapes = glyphShapes;
      } else {
        this.fonts.set(fontId, {
          id: fontId,
          tagCode,
          name: `Font_${fontId}`,
          isBold: false,
          isItalic: false,
          codeTable: [],
          glyphShapes,
        });
      }
      tagInfo.summary = `Font ID ${fontId} (${glyphShapes.length} shapes)`;
    }
  }

  private parseDefineFontInfo(tagCode: number, tagLength: number, tagInfo: SwfTagInfo): void {
    const endPos = tagInfo.offset + tagLength;
    const fontId = this.reader.readUI16();
    tagInfo.characterId = fontId;
    const fontNameLen = this.reader.readUI8();
    const fontNameBytes = this.reader.readBytes(fontNameLen);
    const fontName = decodeSwfString(fontNameBytes);

    const flags = this.reader.readUI8();
    const isSmallText = (flags & 0x20) !== 0;
    const isShiftJIS = (flags & 0x10) !== 0;
    const isANSI = (flags & 0x08) !== 0;
    const isItalic = (flags & 0x04) !== 0;
    const isBold = (flags & 0x02) !== 0;
    const isWideCodes = (flags & 0x01) !== 0;

    let languageCode: number | undefined;
    if (tagCode === 62) {
      languageCode = this.reader.readUI8(); // LanguageCode
    }
    const fontIsShiftJIS = isShiftJIS || languageCode === 2;

    const codeTable: number[] = [];
    // Read only up to end of this tag!
    while (this.reader.pos < endPos && this.reader.remaining >= (isWideCodes ? 2 : 1)) {
      codeTable.push(isWideCodes ? this.reader.readUI16() : this.reader.readUI8());
    }

    const existing = this.fonts.get(fontId);
    if (existing) {
      existing.name = fontName;
      existing.isBold = isBold;
      existing.isItalic = isItalic;
      if (fontIsShiftJIS) existing.isShiftJIS = true;
      if (languageCode) existing.languageCode = languageCode;
      existing.codeTable = codeTable;
    } else {
      this.fonts.set(fontId, {
        id: fontId,
        name: fontName,
        isBold,
        isItalic,
        isShiftJIS: fontIsShiftJIS,
        languageCode,
        codeTable,
      });
    }
    tagInfo.summary = `FontInfo ID ${fontId} "${fontName}" (${codeTable.length} codes)`;
  }

  private parseDefineText(tagCode: number, tagLength: number, tagInfo: SwfTagInfo): void {
    const endPos = tagInfo.offset + tagLength;
    const textId = this.reader.readUI16();
    const bounds = this.reader.readRect();
    const matrix = this.reader.readMatrix();
    tagInfo.characterId = textId;

    const glyphBits = this.reader.readUI8();
    const advanceBits = this.reader.readUI8();

    const records: SwfTextRecord[] = [];
    let initialText = '';

    let currentFontId: number | undefined;
    let currentTextHeight: number | undefined;
    let currentColor: SwfColorRGBA = { r: 255, g: 255, b: 255, a: 1 };
    let curX = 0;
    let curY = 0;

    while (this.reader.pos < endPos && !this.reader.eof) {
      const firstByte = this.reader.readUI8();
      if (firstByte === 0) {
        // End of text records
        break;
      }

      if ((firstByte & 0x80) !== 0) {
        // Style / Setup Record
        const hasFont = (firstByte & 0x08) !== 0;
        const hasColor = (firstByte & 0x04) !== 0;
        const hasYOffset = (firstByte & 0x02) !== 0;
        const hasXOffset = (firstByte & 0x01) !== 0;

        if (hasFont) {
          currentFontId = this.reader.readUI16();
        }
        if (hasColor) {
          currentColor = tagCode === 33 ? this.reader.readRGBA() : this.reader.readRGB();
        }
        let recHasX = false;
        let recHasY = false;
        if (hasXOffset) {
          curX = this.reader.readSI16() / 20.0;
          recHasX = true;
        }
        if (hasYOffset) {
          curY = this.reader.readSI16() / 20.0;
          recHasY = true;
        }
        if (hasFont) {
          currentTextHeight = this.reader.readUI16() / 20.0;
        }
      } else {
        // Glyph Record (bit 7 is 0)
        const glyphCount = firstByte & 0x7f;
        const glyphEntries: { glyphIndex: number; advance: number }[] = [];
        const font = currentFontId !== undefined ? this.fonts.get(currentFontId) : undefined;

        for (let g = 0; g < glyphCount; g++) {
          const glyphIndex = this.reader.readUB(glyphBits);
          const advance = this.reader.readSB(advanceBits) / 20.0;
          glyphEntries.push({ glyphIndex, advance });

          if (font && font.codeTable && font.codeTable[glyphIndex] !== undefined) {
            const code = font.codeTable[glyphIndex];
            if (code > 0) initialText += decodeCharCode(code, font.isShiftJIS);
          } else if (glyphIndex >= 32 && glyphIndex <= 126) {
            initialText += String.fromCharCode(glyphIndex);
          }
        }
        this.reader.alignByte();

        records.push({
          fontId: currentFontId,
          color: { ...currentColor },
          hasXOffset: true,
          xOffset: curX,
          hasYOffset: true,
          yOffset: curY,
          textHeight: currentTextHeight,
          glyphEntries,
        });
      }
    }

    initialText = fixMojibake(initialText);

    const text: SwfText = {
      id: textId,
      bounds,
      matrix,
      textRecords: records,
      initialText,
    };
    this.texts.set(textId, text);
    tagInfo.summary = `Text ID ${textId}${initialText ? ` ("${initialText.trim()}")` : ''}`;
  }

  private parseDefineEditText(tagLength: number, tagInfo: SwfTagInfo): void {
    const textId = this.reader.readUI16();
    const bounds = this.reader.readRect();
    tagInfo.characterId = textId;

    const flags1 = this.reader.readUI8();
    const flags2 = this.reader.readUI8();

    const hasText = (flags1 & 0x80) !== 0;
    const wordWrap = (flags1 & 0x40) !== 0;
    const multiline = (flags1 & 0x20) !== 0;
    const password = (flags1 & 0x10) !== 0;
    const readOnly = (flags1 & 0x08) !== 0;
    const hasColor = (flags1 & 0x04) !== 0;
    const hasMaxLength = (flags1 & 0x02) !== 0;
    const hasFont = (flags1 & 0x01) !== 0;

    const hasFontClass = (flags2 & 0x80) !== 0;
    const autoSize = (flags2 & 0x40) !== 0;
    const hasLayout = (flags2 & 0x20) !== 0;
    const noSelect = (flags2 & 0x10) !== 0;
    const border = (flags2 & 0x08) !== 0;
    const wasStatic = (flags2 & 0x04) !== 0;
    const isHtml = (flags2 & 0x02) !== 0;
    const useOutlines = (flags2 & 0x01) !== 0;

    let fontId: number | undefined;
    let fontHeight = 14;
    if (hasFont) {
      fontId = this.reader.readUI16();
      fontHeight = this.reader.readUI16() / 20.0;
    }

    if (hasFontClass) {
      this.reader.readString(); // FontClass name
    }

    let color: SwfColorRGBA = { r: 0, g: 0, b: 0, a: 1 };
    if (hasColor) {
      color = this.reader.readRGBA();
    }

    if (hasMaxLength) {
      this.reader.readUI16();
    }

    let align = 0; // 0=left, 1=right, 2=center, 3=justify
    let leftMargin = 0;
    let rightMargin = 0;
    let indent = 0;
    let leading = 0;
    if (hasLayout) {
      align = this.reader.readUI8();
      leftMargin = this.reader.readUI16() / 20.0;
      rightMargin = this.reader.readUI16() / 20.0;
      indent = this.reader.readUI16() / 20.0;
      leading = this.reader.readSI16() / 20.0;
    }

    const variableName = this.reader.readString();
    let initialText = '';
    if (hasText) {
      initialText = fixMojibake(this.reader.readString());
    }

    const text: SwfText = {
      id: textId,
      bounds,
      matrix: {
        hasScale: false,
        scaleX: 1,
        scaleY: 1,
        hasRotate: false,
        rotateSkew0: 0,
        rotateSkew1: 0,
        translateX: 0,
        translateY: 0,
      },
      textRecords: [],
      initialText,
      fontId,
      fontHeight: Math.max(8, fontHeight),
      color,
      align,
      isHtml,
      multiline,
      wordWrap,
      variableName,
    };
    this.texts.set(textId, text);
    tagInfo.summary = `EditText ID ${textId}${initialText ? ` ("${initialText.trim()}")` : ''}`;
  }

  private parseDefineSound(tagLength: number, tagInfo: SwfTagInfo): void {
    const soundId = this.reader.readUI16();
    tagInfo.characterId = soundId;

    const flags = this.reader.readUI8();
    const soundFormat = flags >> 4; // 0=PCM, 1=ADPCM, 2=MP3
    const soundRateIndex = (flags >> 2) & 0x03;
    const rates = [5512, 11025, 22050, 44100];
    const rate = rates[soundRateIndex] || 22050;
    const is16Bit = (flags & 0x02) !== 0;
    const isStereo = (flags & 0x01) !== 0;

    const sampleCount = this.reader.readUI32();
    const data = this.reader.readBytes(tagLength - 7);

    const sound: SwfSound = {
      id: soundId,
      format: soundFormat,
      rate,
      is16Bit,
      isStereo,
      sampleCount,
      data,
    };

    this.sounds.set(soundId, sound);
    const formatName = soundFormat === 2 ? 'MP3' : soundFormat === 1 ? 'ADPCM' : 'PCM';
    tagInfo.summary = `Sound ID ${soundId} (${formatName}, ${rate}Hz, ${isStereo ? 'stereo' : 'mono'}, ${sampleCount} samples)`;
  }

  private parseStartSound(frame: SwfFrame, tagInfo: SwfTagInfo): void {
    const soundId = this.reader.readUI16();
    frame.startSounds.push(soundId);
    tagInfo.characterId = soundId;
    tagInfo.summary = `Trigger Sound ID ${soundId}`;
  }

  private parseSoundStreamHead(tagCode: number, tagLength: number, tagInfo: SwfTagInfo): void {
    this.reader.alignByte();
    this.reader.readUB(4); // reserved
    const playbackRate = this.reader.readUB(2);
    const playbackSize = this.reader.readUB(1);
    const playbackType = this.reader.readUB(1);

    const streamFormat = this.reader.readUB(4); // 2 = MP3
    const streamRateIdx = this.reader.readUB(2);
    const streamRates = [5512, 11025, 22050, 44100];
    const streamRate = streamRates[streamRateIdx] || 22050;
    const streamSize = this.reader.readUB(1);
    const streamType = this.reader.readUB(1);
    const sampleCount = this.reader.readUI16();

    if (streamFormat === 2 && tagLength >= 6) {
      this.reader.readSI16(); // latencySeek
    }

    this.streamSoundConfig = {
      format: streamFormat,
      playbackRate: streamRates[playbackRate] || 22050,
      streamRate,
      is16Bit: streamSize === 1,
      isStereo: streamType === 1,
      sampleCount,
    };

    const formatName = streamFormat === 2 ? 'MP3' : streamFormat === 1 ? 'ADPCM' : 'PCM';
    tagInfo.summary = `Stream Audio Head: ${formatName} ${streamRate}Hz ${streamType === 1 ? 'stereo' : 'mono'}`;
  }

  private parseSoundStreamBlock(tagLength: number, tagInfo: SwfTagInfo): void {
    const rawData = this.reader.readBytes(tagLength);

    if (this.streamSoundConfig && this.streamSoundConfig.format === 2) {
      // Find MP3 sync word (0xFF with top 3 bits of next byte = 0xE0) in first 16 bytes
      let startIdx = 0;
      for (let i = 0; i < Math.min(16, rawData.length - 1); i++) {
        if (rawData[i] === 0xff && (rawData[i + 1] & 0xe0) === 0xe0) {
          startIdx = i;
          break;
        }
      }

      const mp3Frames = rawData.subarray(startIdx);
      if (mp3Frames.length > 0) {
        this.streamMp3Chunks.push(mp3Frames);
      }
      tagInfo.summary = `Stream Block (${(rawData.length / 1024).toFixed(1)} KB MP3)`;
    } else {
      tagInfo.summary = `Stream Block (${rawData.length} bytes)`;
    }
  }

  private parseDefineVideoStream(tagInfo: SwfTagInfo): void {
    const characterId = this.reader.readUI16();
    const numFrames = this.reader.readUI16();
    const width = this.reader.readUI16();
    const height = this.reader.readUI16();
    const flags = this.reader.readUI8();
    const deblocking = (flags >> 1) & 0x07;
    const smoothing = (flags & 0x01) === 1;
    const codecId = this.reader.readUI8();

    const codecNames: Record<number, string> = {
      1: 'JPEG / Motion JPEG',
      2: 'Sorenson Spark (H.263)',
      3: 'Screen Video v1',
      4: 'On2 VP6',
      5: 'On2 VP6 + Alpha',
      6: 'Screen Video v2',
      7: 'AVC / H.264',
    };
    const codecVersions: Record<number, string> = {
      1: 'JPEG / JFIF 1.02',
      2: 'Sorenson Spark v1 (Flash 6+)',
      3: 'Screen Video v1 (Zlib Tiled)',
      4: 'VP6.2 Profile (Flash 8+)',
      5: 'VP6.2 + Alpha Channel',
      6: 'Screen Video v2 (Deblocking)',
      7: 'MPEG-4 Part 10 (AVC / H.264)',
    };
    const codecName = codecNames[codecId] || `Codec_${codecId}`;
    const versionName = codecVersions[codecId] || `Flash Video Stream`;

    const stream: SwfVideoStream = {
      id: characterId,
      numFrames,
      width,
      height,
      deblocking,
      smoothing,
      codecId,
      codecName,
      versionName,
      videoType: codecId === 1 ? 'jpeg' : codecId === 2 ? 'spark' : codecId === 3 || codecId === 6 ? 'screenvideo' : codecId === 4 || codecId === 5 ? 'vp6' : codecId === 7 ? 'avc' : 'spark',
      frames: new Map(),
    };

    this.videoStreams.set(characterId, stream);
    tagInfo.characterId = characterId;
    tagInfo.summary = `Video #${characterId} (${width}x${height}px, ${numFrames} frames, ${codecName} · ${versionName})`;
  }

  private parseVideoFrame(tagLength: number, tagInfo: SwfTagInfo): void {
    const streamId = this.reader.readUI16();
    const frameNum = this.reader.readUI16();
    const dataLength = Math.max(0, tagLength - 4);
    const videoData = this.reader.readBytes(dataLength);

    tagInfo.characterId = streamId;

    let stream = this.videoStreams.get(streamId);
    if (!stream) {
      stream = {
        id: streamId,
        numFrames: frameNum + 1,
        width: 320,
        height: 240,
        deblocking: 0,
        smoothing: true,
        codecId: 2,
        codecName: 'Sorenson Spark (H.263)',
        versionName: 'Sorenson Spark v1 (Flash 6+)',
        videoType: 'spark',
        frames: new Map(),
      };
      this.videoStreams.set(streamId, stream);
    }

    // Inspect frame data to detect true video type, version, and picture type
    const formatInfo = VideoDecoderEngine.detectVideoFormat(videoData, stream.codecId);
    if (formatInfo.versionName) {
      stream.versionName = formatInfo.versionName;
    }
    if (formatInfo.codecName) {
      stream.codecName = formatInfo.codecName;
    }
    if (formatInfo.videoType) {
      stream.videoType = formatInfo.videoType;
    }

    tagInfo.summary = `Stream #${streamId}, Frame #${frameNum} [${formatInfo.codecName} · ${formatInfo.versionName}${formatInfo.pictureType ? ` · ${formatInfo.pictureType}` : ''}] (${dataLength} bytes)`;

    stream.frames.set(frameNum, {
      frameNum,
      data: videoData,
      videoType: formatInfo.videoType,
      versionName: formatInfo.versionName,
      isKeyframe: formatInfo.isKeyframe,
      pictureType: formatInfo.pictureType,
    });
  }
}
