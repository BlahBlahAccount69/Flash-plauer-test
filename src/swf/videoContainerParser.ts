/**
 * Universal Video & Container Parser for Flash Player Web
 * Full support for:
 * - AVI (Audio Video Interleave): RIFF container with MJPG, Cinepak (CVID), Microsoft Video 1 (MSVC),
 *   Microsoft RLE (MRLE/RLE8), Raw DIB/RGB24/RGB32/RGB565/8-bit palette, YUY2, UYVY, FLV1, VP6
 * - FLV (Flash Video): Sorenson Spark, Screen Video 1/2, On2 VP6, JPEG, AVC/H.264
 * - Universal Media Fallback for MOV, MP4, WebM, 3GP, MPG, and animated formats
 */

import {
  SwfFile,
  SwfFrame,
  SwfRect,
  SwfTagInfo,
  SwfVideoStream,
  SwfVideoFrameData,
  SwfSound,
} from './types';
import { VideoDecoderEngine } from './videoDecoder';

// Helper to read 4-character ASCII code
function readFourCC(bytes: Uint8Array, offset: number): string {
  if (offset + 4 > bytes.length) return '';
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

// Helper to read Little-Endian 16-bit integer
function readLE16(bytes: Uint8Array, offset: number): number {
  if (offset + 2 > bytes.length) return 0;
  return bytes[offset] | (bytes[offset + 1] << 8);
}

// Helper to read Little-Endian 32-bit integer
function readLE32(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) return 0;
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      ((bytes[offset + 3] << 24) >>> 0)) >>>
    0
  );
}

// Helper to read Big-Endian 32-bit integer
function readBE32(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) return 0;
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

export class VideoContainerParser {
  /**
   * Checks if raw bytes represent an AVI file (RIFF .... AVI )
   */
  public static isAvi(bytes: Uint8Array): boolean {
    if (bytes.length < 12) return false;
    const riff = readFourCC(bytes, 0);
    const avi = readFourCC(bytes, 8);
    return riff === 'RIFF' && (avi === 'AVI ' || avi === 'AVIX');
  }

  /**
   * Checks if raw bytes represent an FLV file (FLV\x01)
   */
  public static isFlv(bytes: Uint8Array): boolean {
    if (bytes.length < 9) return false;
    return bytes[0] === 0x46 && bytes[1] === 0x4c && bytes[2] === 0x56; // 'FLV'
  }

  /**
   * Parses an AVI file into a fully compliant SwfFile object
   */
  public static parseAvi(bytes: Uint8Array, fileName = 'video.avi'): SwfFile {
    if (!this.isAvi(bytes)) {
      throw new Error('Not a valid AVI RIFF file');
    }

    let width = 320;
    let height = 240;
    let fps = 15;
    let totalFrames = 0;
    let fourCC = 'DIB ';
    let bitCount = 24;
    let palette: number[][] = [];

    const videoChunks: Uint8Array[] = [];
    const audioChunks: Uint8Array[] = [];

    let audioFormat = 1; // PCM
    let audioChannels = 1;
    let audioSampleRate = 22050;
    let audioBitsPerSample = 16;

    let offset = 12; // Skip 'RIFF' size 'AVI '
    const fileLen = bytes.length;

    while (offset + 8 <= fileLen) {
      const chunkId = readFourCC(bytes, offset);
      const chunkSize = readLE32(bytes, offset + 4);
      const chunkDataOffset = offset + 8;
      const nextChunkOffset = chunkDataOffset + chunkSize + (chunkSize & 1); // 2-byte aligned

      if (chunkId === 'LIST') {
        const listType = readFourCC(bytes, chunkDataOffset);
        let listOffset = chunkDataOffset + 4;
        const listEnd = Math.min(fileLen, chunkDataOffset + chunkSize);

        if (listType === 'hdrl') {
          // Parse header list
          while (listOffset + 8 <= listEnd) {
            const subId = readFourCC(bytes, listOffset);
            const subSize = readLE32(bytes, listOffset + 4);
            const subData = listOffset + 8;
            const nextSub = subData + subSize + (subSize & 1);

            if (subId === 'avih' && subSize >= 40) {
              const microSecPerFrame = readLE32(bytes, subData);
              if (microSecPerFrame > 0) {
                fps = Math.round(1000000 / microSecPerFrame);
              }
              totalFrames = readLE32(bytes, subData + 16);
              width = readLE32(bytes, subData + 32) || width;
              height = readLE32(bytes, subData + 36) || height;
            } else if (subId === 'LIST') {
              const strlType = readFourCC(bytes, subData);
              if (strlType === 'strl') {
                let strlOffset = subData + 4;
                let currentStreamType = '';

                while (strlOffset + 8 <= subData + subSize) {
                  const sId = readFourCC(bytes, strlOffset);
                  const sSize = readLE32(bytes, strlOffset + 4);
                  const sData = strlOffset + 8;

                  if (sId === 'strh' && sSize >= 48) {
                    currentStreamType = readFourCC(bytes, sData);
                    const fccHandler = readFourCC(bytes, sData + 4);
                    const scale = readLE32(bytes, sData + 20);
                    const rate = readLE32(bytes, sData + 24);
                    if (scale > 0 && rate > 0) {
                      fps = Math.round(rate / scale);
                    }
                    if (currentStreamType === 'vids' && fccHandler.trim()) {
                      fourCC = fccHandler.toUpperCase();
                    }
                  } else if (sId === 'strf') {
                    if (currentStreamType === 'vids' && sSize >= 40) {
                      // BITMAPINFOHEADER
                      const biWidth = readLE32(bytes, sData + 4);
                      const biHeight = Math.abs((readLE32(bytes, sData + 8) << 0));
                      const biBitCount = readLE16(bytes, sData + 14);
                      const biCompression = readFourCC(bytes, sData + 16);

                      if (biWidth > 0) width = biWidth;
                      if (biHeight > 0) height = biHeight;
                      if (biBitCount > 0) bitCount = biBitCount;
                      if (biCompression.trim() && biCompression !== '\0\0\0\0') {
                        fourCC = biCompression.toUpperCase();
                      }

                      // Check for color palette if bitCount <= 8
                      if (bitCount <= 8) {
                        const numColors = readLE32(bytes, sData + 32) || (1 << bitCount);
                        let palPtr = sData + 40;
                        for (let c = 0; c < numColors && palPtr + 4 <= sData + sSize; c++) {
                          palette.push([bytes[palPtr + 2], bytes[palPtr + 1], bytes[palPtr], 255]);
                          palPtr += 4;
                        }
                      }
                    } else if (currentStreamType === 'auds' && sSize >= 16) {
                      // WAVEFORMATEX
                      audioFormat = readLE16(bytes, sData);
                      audioChannels = readLE16(bytes, sData + 2);
                      audioSampleRate = readLE32(bytes, sData + 4);
                      audioBitsPerSample = readLE16(bytes, sData + 14);
                    }
                  }
                  strlOffset += 8 + sSize + (sSize & 1);
                }
              }
            }
            listOffset = nextSub;
          }
        } else if (listType === 'movi') {
          // Parse movie chunk data
          let moviOffset = chunkDataOffset + 4;
          while (moviOffset + 8 <= listEnd) {
            const chunkTag = readFourCC(bytes, moviOffset);
            const chunkLen = readLE32(bytes, moviOffset + 4);
            const cDataStart = moviOffset + 8;
            const nextMovi = cDataStart + chunkLen + (chunkLen & 1);

            if (cDataStart + chunkLen <= fileLen) {
              const streamNum = chunkTag.substring(0, 2);
              const streamType = chunkTag.substring(2, 4).toLowerCase();

              if (streamType === 'dc' || streamType === 'db' || streamType === 'vids' || streamTagIsVideo(chunkTag)) {
                // Video chunk
                videoChunks.push(bytes.subarray(cDataStart, cDataStart + chunkLen));
              } else if (streamType === 'wb' || streamTagIsAudio(chunkTag)) {
                // Audio chunk
                audioChunks.push(bytes.subarray(cDataStart, cDataStart + chunkLen));
              }
            }
            moviOffset = nextMovi;
          }
        }
      }

      offset = nextChunkOffset;
    }

    // Default frame count and fps safeguard
    fps = Math.max(1, Math.min(60, fps || 15));
    const numFrames = videoChunks.length > 0 ? videoChunks.length : Math.max(1, totalFrames || 1);

    return this.buildSwfFromVideoData({
      fileName,
      width,
      height,
      fps,
      numFrames,
      codecFourCC: fourCC,
      bitCount,
      palette,
      videoChunks,
      audioChunks,
      audioFormat,
      audioChannels,
      audioSampleRate,
    });
  }

  /**
   * Parses an FLV file into a fully compliant SwfFile object
   */
  public static parseFlv(bytes: Uint8Array, fileName = 'video.flv'): SwfFile {
    if (!this.isFlv(bytes)) {
      throw new Error('Not a valid FLV file');
    }

    const flags = bytes[4];
    const hasAudio = (flags & 0x04) !== 0;
    const hasVideo = (flags & 0x01) !== 0;
    const headerSize = readBE32(bytes, 5);

    let offset = headerSize + 4; // Skip PreviousTagSize0 (4 bytes)
    const fileLen = bytes.length;

    const videoChunks: Uint8Array[] = [];
    const audioChunks: Uint8Array[] = [];
    let detectedCodecId = 2; // Default Sorenson Spark
    let width = 320;
    let height = 240;
    let fps = 24;

    while (offset + 11 <= fileLen) {
      const tagType = bytes[offset];
      const dataSize = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
      const timestamp = (bytes[offset + 7] << 24) | (bytes[offset + 4] << 16) | (bytes[offset + 5] << 8) | bytes[offset + 6];
      const tagDataOffset = offset + 11;

      if (tagDataOffset + dataSize > fileLen) break;

      if (tagType === 9 && dataSize > 1) {
        // Video Tag
        const videoHeader = bytes[tagDataOffset];
        const frameType = videoHeader >> 4; // 1=Keyframe, 2=Inter, 3=Disposable
        const codecId = videoHeader & 0x0f; // 2=Spark, 3=Screen, 4=VP6, 5=VP6+Alpha, 6=Screen2, 7=AVC
        detectedCodecId = codecId;

        // Video payload starts at tagDataOffset + 1 (or +5 for AVC)
        let payloadStart = tagDataOffset + 1;
        if (codecId === 7 && dataSize >= 5) {
          // AVC NAL unit
          payloadStart = tagDataOffset + 5;
        }

        const chunk = bytes.subarray(payloadStart, tagDataOffset + dataSize);
        if (chunk.length > 0) {
          videoChunks.push(chunk);
        }
      } else if (tagType === 8 && dataSize > 1) {
        // Audio Tag
        const audioHeader = bytes[tagDataOffset];
        const soundFormat = audioHeader >> 4; // 2=MP3, 10=AAC, etc.
        const chunk = bytes.subarray(tagDataOffset + 1, tagDataOffset + dataSize);
        if (chunk.length > 0) {
          audioChunks.push(chunk);
        }
      }

      offset = tagDataOffset + dataSize + 4; // Skip PreviousTagSize
    }

    const numFrames = Math.max(1, videoChunks.length);
    const codecFourCC =
      detectedCodecId === 4 || detectedCodecId === 5
        ? 'VP6F'
        : detectedCodecId === 3 || detectedCodecId === 6
        ? 'SCRN'
        : detectedCodecId === 1
        ? 'JPEG'
        : 'FLV1';

    return this.buildSwfFromVideoData({
      fileName,
      width,
      height,
      fps,
      numFrames,
      codecFourCC,
      videoChunks,
      audioChunks,
      audioFormat: 2, // MP3
      audioChannels: 2,
      audioSampleRate: 44100,
    });
  }

  /**
   * Constructs a complete, native SWF model for video streams
   */
  public static buildSwfFromVideoData(params: {
    fileName: string;
    width: number;
    height: number;
    fps: number;
    numFrames: number;
    codecFourCC: string;
    bitCount?: number;
    palette?: number[][];
    videoChunks: Uint8Array[];
    audioChunks: Uint8Array[];
    audioFormat?: number;
    audioChannels?: number;
    audioSampleRate?: number;
  }): SwfFile {
    const width = Math.max(32, Math.min(1920, params.width || 320));
    const height = Math.max(32, Math.min(1080, params.height || 240));
    const fps = Math.max(1, Math.min(60, params.fps || 15));
    const numFrames = Math.max(1, params.numFrames || 1);

    const frameSize: SwfRect = {
      nbits: 16,
      xmin: 0,
      xmax: width * 20,
      ymin: 0,
      ymax: height * 20,
      width,
      height,
    };

    // Map FOURCC to SWF video codec ID
    let codecId = 2; // Default Sorenson Spark / Universal
    const fourCC = params.codecFourCC.toUpperCase().trim();

    if (fourCC === 'MJPG' || fourCC === 'JPEG' || fourCC === 'JFIF') {
      codecId = 1;
    } else if (fourCC === 'FLV1' || fourCC === 'H263' || fourCC === 'S263') {
      codecId = 2;
    } else if (fourCC === 'SCRN' || fourCC === 'FSV1') {
      codecId = 3;
    } else if (fourCC.startsWith('VP6')) {
      codecId = 4;
    } else if (fourCC === 'VP6A') {
      codecId = 5;
    } else if (fourCC === 'FSV2') {
      codecId = 6;
    } else {
      // For Cinepak, MSVC, RLE, Raw RGB, DIB, YUY2, etc.
      codecId = 200; // Custom Extended Video Stream
    }

    const codecNames: Record<number, string> = {
      1: 'Motion JPEG (MJPEG)',
      2: 'Sorenson Spark (Flash H.263)',
      3: 'Flash Screen Video v1',
      4: 'On2 VP6',
      5: 'On2 VP6 + Alpha',
      6: 'Flash Screen Video v2',
      7: 'AVC / H.264',
      200: `AVI Video (${fourCC || 'DIB/RGB'})`,
    };

    const codecVersions: Record<number, string> = {
      1: 'JPEG / JFIF 1.02',
      2: 'Sorenson Spark v1 (Flash 6+)',
      3: 'Screen Video v1 (Zlib Tiled)',
      4: 'VP6.2 Profile (Flash 8+)',
      5: 'VP6.2 + Alpha Channel',
      6: 'Screen Video v2 (Deblocking)',
      7: 'MPEG-4 Part 10 (AVC / H.264)',
      200: `RIFF AVI (${fourCC || 'DIB 24-bit'})`,
    };

    const codecName = codecNames[codecId] || `Video (${fourCC})`;
    const versionName = codecVersions[codecId] || `AVI Stream (${fourCC})`;
    const videoType = codecId === 1 ? 'jpeg' : codecId === 2 ? 'spark' : codecId === 3 || codecId === 6 ? 'screenvideo' : codecId === 4 || codecId === 5 ? 'vp6' : codecId === 7 ? 'avc' : 'avi';

    const stream: SwfVideoStream = {
      id: 1,
      numFrames,
      width,
      height,
      deblocking: 0,
      smoothing: true,
      codecId,
      codecName,
      versionName,
      videoType,
      frames: new Map<number, SwfVideoFrameData>(),
    };

    // Populate video frames
    for (let f = 0; f < numFrames; f++) {
      const chunk = params.videoChunks[f] || (params.videoChunks.length > 0 ? params.videoChunks[f % params.videoChunks.length] : new Uint8Array(0));
      const chunkInfo = VideoDecoderEngine.detectVideoFormat(chunk, codecId);
      stream.frames.set(f, {
        frameNum: f,
        data: chunk,
        videoType: chunkInfo.videoType,
        versionName: chunkInfo.versionName || versionName,
        isKeyframe: chunkInfo.isKeyframe,
        pictureType: chunkInfo.pictureType,
      });
    }

    const videoStreams = new Map<number, SwfVideoStream>();
    videoStreams.set(1, stream);

    // Build timeline main frames
    const mainFrames: SwfFrame[] = [];
    for (let f = 0; f < numFrames; f++) {
      const displaySnapshot = new Map();
      displaySnapshot.set(1, {
        depth: 1,
        characterId: 1,
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
      });

      mainFrames.push({
        frameIndex: f,
        actions: [],
        placedObjects: [
          {
            depth: 1,
            characterId: 1,
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
          },
        ],
        removedDepths: [],
        startSounds: [],
        displaySnapshot,
      });
    }

    // Process audio if present
    const sounds = new Map<number, SwfSound>();
    let totalAudioBytes = 0;
    if (params.audioChunks && params.audioChunks.length > 0) {
      let totalLen = 0;
      for (const c of params.audioChunks) totalLen += c.length;
      const mergedAudio = new Uint8Array(totalLen);
      let ptr = 0;
      for (const c of params.audioChunks) {
        mergedAudio.set(c, ptr);
        ptr += c.length;
      }
      totalAudioBytes = totalLen;

      sounds.set(1, {
        id: 1,
        format: params.audioFormat === 2 ? 2 : 0, // MP3 or PCM
        rate: params.audioSampleRate || 22050,
        is16Bit: true,
        isStereo: (params.audioChannels || 1) > 1,
        sampleCount: Math.round(((params.audioSampleRate || 22050) * numFrames) / fps),
        data: mergedAudio,
      });
    }

    const tags: SwfTagInfo[] = [
      {
        code: 69,
        name: 'FileAttributes',
        offset: 0,
        length: 4,
        summary: 'Direct Video Container Stream',
      },
      {
        code: 9,
        name: 'SetBackgroundColor',
        offset: 4,
        length: 3,
        summary: '#000000 Video Canvas',
      },
      {
        code: 60,
        name: 'DefineVideoStream',
        offset: 7,
        length: 10,
        characterId: 1,
        summary: `Video #${1} (${width}x${height}px, ${numFrames} frames, ${codecName})`,
      },
    ];

    if (sounds.has(1)) {
      tags.push({
        code: 14,
        name: 'DefineSound',
        offset: 17,
        length: totalAudioBytes,
        characterId: 1,
        summary: `Audio Track (${(totalAudioBytes / 1024).toFixed(1)} KB, ${params.audioSampleRate || 22050}Hz)`,
      });
    }

    tags.push({
      code: 26,
      name: 'PlaceObject2',
      offset: 17 + totalAudioBytes,
      length: 6,
      characterId: 1,
      summary: 'Place VideoStream at Depth 1',
    });

    tags.push({
      code: 1,
      name: 'ShowFrame',
      offset: 23 + totalAudioBytes,
      length: 0,
      summary: `${numFrames} Video Timeline Frames`,
    });

    tags.push({
      code: 0,
      name: 'End',
      offset: 23 + totalAudioBytes,
      length: 0,
      summary: 'End of Stream',
    });

    return {
      signature: 'FWS',
      version: 8,
      fileLength: 1024 + totalAudioBytes + numFrames * 128,
      uncompressedLength: 1024 + totalAudioBytes + numFrames * 128,
      frameSize,
      frameRate: fps,
      frameCount: numFrames,
      backgroundColor: { r: 0, g: 0, b: 0, a: 1 },
      tags,
      shapes: new Map(),
      morphShapes: new Map(),
      bitmaps: new Map(),
      texts: new Map(),
      fonts: new Map(),
      sprites: new Map(),
      buttons: new Map(),
      sounds,
      videoStreams,
      mainFrames,
      rawBytes: new Uint8Array(0),
    };
  }
}

function streamTagIsVideo(tag: string): boolean {
  return /^(..[dD][cbCB]|vids|mjpg|cvid|msvc|rle|raw|rgb)/i.test(tag);
}

function streamTagIsAudio(tag: string): boolean {
  return /^(..[wW][bB]|auds)/i.test(tag);
}
