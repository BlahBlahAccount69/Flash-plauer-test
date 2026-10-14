/**
 * SWF (Shockwave Flash) Types and Data Structures
 */

export interface SwfRect {
  nbits: number;
  xmin: number; // in twips (20 twips = 1 pixel)
  xmax: number;
  ymin: number;
  ymax: number;
  width: number;  // in pixels
  height: number; // in pixels
}

export interface SwfMatrix {
  hasScale: boolean;
  scaleX: number;
  scaleY: number;
  hasRotate: boolean;
  rotateSkew0: number;
  rotateSkew1: number;
  translateX: number; // in pixels
  translateY: number; // in pixels
}

export interface SwfColorRGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface SwfColorTransform {
  hasAdd: boolean;
  hasMult: boolean;
  multR: number;
  multG: number;
  multB: number;
  multA: number;
  addR: number;
  addG: number;
  addB: number;
  addA: number;
}

export type SwfFillStyleType = 'solid' | 'linearGradient' | 'radialGradient' | 'bitmap';

export interface SwfGradientRecord {
  ratio: number; // 0 to 255
  color: SwfColorRGBA;
}

export interface SwfFillStyle {
  type: SwfFillStyleType;
  color?: SwfColorRGBA;
  gradientMatrix?: SwfMatrix;
  gradients?: SwfGradientRecord[];
  bitmapId?: number;
  bitmapMatrix?: SwfMatrix;
  repeat?: boolean;
}

export interface SwfLineStyle {
  width: number; // in pixels
  color: SwfColorRGBA;
}

export interface SwfShapePath {
  fillStyle0: number; // 1-based index or 0
  fillStyle1: number;
  lineStyle: number;
  commands: SwfDrawCommand[];
}

export type SwfDrawCommand =
  | { type: 'moveTo'; x: number; y: number }
  | { type: 'lineTo'; x: number; y: number }
  | { type: 'curveTo'; cx: number; cy: number; ax: number; ay: number };

export interface SwfMorphFillStyle {
  type: SwfFillStyleType;
  startColor?: SwfColorRGBA;
  endColor?: SwfColorRGBA;
  startGradientMatrix?: SwfMatrix;
  endGradientMatrix?: SwfMatrix;
  startGradients?: SwfGradientRecord[];
  endGradients?: SwfGradientRecord[];
  bitmapId?: number;
  startBitmapMatrix?: SwfMatrix;
  endBitmapMatrix?: SwfMatrix;
  repeat?: boolean;
}

export interface SwfMorphLineStyle {
  startWidth: number;
  endWidth: number;
  startColor: SwfColorRGBA;
  endColor: SwfColorRGBA;
}

export interface SwfMorphEdge {
  startX0: number;
  startY0: number;
  startCX: number;
  startCY: number;
  startX1: number;
  startY1: number;
  startIsCurve: boolean;

  endX0: number;
  endY0: number;
  endCX: number;
  endCY: number;
  endX1: number;
  endY1: number;
  endIsCurve: boolean;

  isNewSubpath: boolean;

  fillStyle0: number;
  fillStyle1: number;
  lineStyle: number;
}

export interface SwfMorphShape {
  id: number;
  startBounds: SwfRect;
  endBounds: SwfRect;
  fillStyles: SwfMorphFillStyle[];
  lineStyles: SwfMorphLineStyle[];
  startPaths: SwfShapePath[];
  endPaths: SwfShapePath[];
  morphEdges?: SwfMorphEdge[];
}

export interface SwfShape {
  id: number;
  bounds: SwfRect;
  fillStyles: SwfFillStyle[];
  lineStyles: SwfLineStyle[];
  paths: SwfShapePath[];
}

export interface SwfBitmap {
  id: number;
  format: 'jpeg' | 'lossless' | 'lossless2';
  width: number;
  height: number;
  dataUrl?: string;
  imageElement?: HTMLImageElement;
  canvasElement?: HTMLCanvasElement;
  rawBytes?: Uint8Array;
  mimeType?: string;
  isLoaded?: boolean;
}

export interface SwfTextRecord {
  fontId?: number;
  color?: SwfColorRGBA;
  hasXOffset?: boolean;
  xOffset?: number;
  hasYOffset?: boolean;
  yOffset?: number;
  textHeight?: number;
  glyphEntries: { glyphIndex: number; advance: number }[];
}

export interface SwfText {
  id: number;
  bounds: SwfRect;
  matrix: SwfMatrix;
  textRecords: SwfTextRecord[];
  initialText?: string;
  fontId?: number;
  fontHeight?: number;
  color?: SwfColorRGBA;
  align?: number; // 0=left, 1=right, 2=center, 3=justify
  isHtml?: boolean;
  multiline?: boolean;
  wordWrap?: boolean;
  variableName?: string;
}

export interface SwfFont {
  id: number;
  tagCode?: number;
  name: string;
  isBold: boolean;
  isItalic: boolean;
  isShiftJIS?: boolean;
  languageCode?: number;
  codeTable?: number[];
  glyphShapes?: SwfShape[];
}

export interface SwfButtonRecord {
  stateHitTest: boolean;
  stateDown: boolean;
  stateOver: boolean;
  stateUp: boolean;
  characterId: number;
  depth: number;
  matrix: SwfMatrix;
  colorTransform?: SwfColorTransform;
}

export interface SwfButton {
  id: number;
  characters: SwfButtonRecord[];
  actions?: SwfAction[];
}

export interface SwfAction {
  code: number;
  name: string;
  args?: any;
}

export interface SwfVideoFrameData {
  frameNum: number;
  data: Uint8Array;
  canvasElement?: HTMLCanvasElement;
  imageElement?: HTMLImageElement;
  isDecoded?: boolean;
  videoType?: string;
  versionName?: string;
  isKeyframe?: boolean;
  pictureType?: string;
}

export interface SwfVideoStream {
  id: number;
  numFrames: number;
  width: number;
  height: number;
  deblocking: number;
  smoothing: boolean;
  codecId: number; // 1 = JPEG, 2 = Sorenson H.263, 3 = Screen Video, 4 = VP6, 5 = VP6+Alpha, 6 = Screen Video V2, 7 = AVC/H.264
  codecName: string;
  versionName?: string;
  videoType?: string;
  frames: Map<number, SwfVideoFrameData>;
  currentDecodedCanvas?: HTMLCanvasElement;
  lastDecodedFrameNum?: number;
  refYPlane?: Uint8ClampedArray;
  refCbPlane?: Uint8ClampedArray;
  refCrPlane?: Uint8ClampedArray;
}

export interface SwfDisplayObject {
  depth: number;
  characterId: number;
  matrix: SwfMatrix;
  colorTransform?: SwfColorTransform;
  clipDepth?: number;
  name?: string;
  ratio?: number;
}

export interface SwfFrame {
  frameIndex: number;
  label?: string;
  actions: SwfAction[];
  placedObjects: SwfDisplayObject[];
  removedDepths: number[];
  startSounds: number[];
  // Complete display list snapshot at this frame
  displaySnapshot?: Map<number, SwfDisplayObject>;
}

export interface SwfSprite {
  id: number;
  frameCount: number;
  frames: SwfFrame[];
}

export interface SwfSound {
  id: number;
  format: number; // 0=uncompressed, 1=ADPCM, 2=MP3
  rate: number;   // 5512, 11025, 22050, 44100
  is16Bit: boolean;
  isStereo: boolean;
  sampleCount: number;
  audioBuffer?: AudioBuffer;
  data: Uint8Array;
}

export interface SwfStreamSound {
  format: number; // 2=MP3
  playbackRate: number;
  streamRate: number;
  is16Bit: boolean;
  isStereo: boolean;
  sampleCount: number;
  allMp3Bytes: Uint8Array;
  audioBuffer?: AudioBuffer;
}

export interface SwfTagInfo {
  code: number;
  name: string;
  offset: number;
  length: number;
  characterId?: number;
  summary?: string;
}

export interface SwfFile {
  signature: 'FWS' | 'CWS' | 'ZWS';
  version: number;
  fileLength: number;
  uncompressedLength: number;
  frameSize: SwfRect;
  frameRate: number;
  frameCount: number;
  backgroundColor: SwfColorRGBA;
  tags: SwfTagInfo[];
  shapes: Map<number, SwfShape>;
  morphShapes: Map<number, SwfMorphShape>;
  bitmaps: Map<number, SwfBitmap>;
  texts: Map<number, SwfText>;
  fonts: Map<number, SwfFont>;
  sprites: Map<number, SwfSprite>;
  buttons: Map<number, SwfButton>;
  sounds: Map<number, SwfSound>;
  videoStreams: Map<number, SwfVideoStream>;
  streamSound?: SwfStreamSound;
  mainFrames: SwfFrame[];
  rawBytes: Uint8Array;
}
