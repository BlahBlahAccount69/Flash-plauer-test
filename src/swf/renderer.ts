/**
 * SWF Canvas 2D Renderer
 * Renders vector shapes with even-odd multi-path fills, strokes, gradients,
 * bitmaps, text, buttons, and nested sprite display lists
 */

import { decodeCharCode, fixMojibake } from './stringUtils';
import {
  SwfBitmap,
  SwfButton,
  SwfColorRGBA,
  SwfColorTransform,
  SwfDisplayObject,
  SwfDrawCommand,
  SwfFile,
  SwfFillStyle,
  SwfFrame,
  SwfGradientRecord,
  SwfLineStyle,
  SwfMatrix,
  SwfMorphShape,
  SwfRect,
  SwfShape,
  SwfShapePath,
  SwfSprite,
  SwfText,
  SwfVideoStream,
} from './types';
import { VideoDecoderEngine } from './videoDecoder';
import { interpolateMorphShape as computeMorphShape } from './morphUtils';

export interface DisplayEntry {
  depth: number;
  characterId: number;
  matrix: SwfMatrix;
  colorTransform?: any;
  clipDepth?: number;
  name?: string;
  ratio?: number;
  spriteState?: {
    currentFrame: number;
  };
}

export interface DragState {
  isDragging: boolean;
  depth: number;
  characterId: number;
  startX: number;
  startY: number;
  origMatrixTx: number;
  origMatrixTy: number;
  bounds?: { xmin: number; ymin: number; xmax: number; ymax: number; width: number; height: number };
}

export class SwfRenderer {
  private swf: SwfFile;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private displayList = new Map<number, DisplayEntry>();
  private currentFrameIndex = 0;

  // Track sprite states (character instance key -> currentFrame)
  private spriteFrames = new Map<string, number>();

  // Interaction states for buttons
  public pointerX = -1000;
  public pointerY = -1000;
  public isPointerDown = false;
  public hoveredButtonId: number | null = null;
  public activeButtonClicked: ((buttonId: number) => void) | null = null;

  // Paused mode asset dragging
  public isPaused = true;
  public isDraggingAsset = false;
  public hoveredAssetInfo: { depth: number; characterId: number; name?: string } | null = null;
  public dragState: DragState | null = null;
  public hasModifiedPositions = false;
  private originalMatrices = new Map<number, SwfMatrix>();

  public onHoverAssetChange?: (info: { depth: number; characterId: number; name?: string } | null) => void;
  public onDragStateChange?: (dragging: boolean, info: { depth: number; characterId: number } | null) => void;
  public onPositionsModifiedChange?: (hasModified: boolean) => void;

  constructor(swf: SwfFile, canvas: HTMLCanvasElement) {
    this.swf = swf;
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D context from canvas');
    this.ctx = ctx;
  }

  public reset(): void {
    this.displayList.clear();
    this.spriteFrames.clear();
    this.originalMatrices.clear();
    this.dragState = null;
    this.hoveredAssetInfo = null;
    this.isDraggingAsset = false;
    this.hasModifiedPositions = false;
    this.currentFrameIndex = 0;
    this.hoveredButtonId = null;
  }

  public setFrame(targetFrame: number): void {
    if (this.swf.mainFrames.length === 0) return;
    targetFrame = Math.max(0, Math.min(targetFrame, this.swf.mainFrames.length - 1));
    this.currentFrameIndex = targetFrame;

    const frame = this.swf.mainFrames[targetFrame];
    if (frame && frame.displaySnapshot) {
      // Use exact pre-computed frame snapshot
      this.displayList.clear();
      for (const [depth, obj] of frame.displaySnapshot.entries()) {
        const spriteKey = `${depth}_${obj.characterId}`;
        const curSpriteFrame = (this.spriteFrames.get(spriteKey) ?? 0);

        this.displayList.set(depth, {
          depth: obj.depth,
          characterId: obj.characterId,
          matrix: { ...obj.matrix },
          colorTransform: obj.colorTransform,
          clipDepth: obj.clipDepth,
          name: obj.name,
          ratio: obj.ratio,
          spriteState: {
            currentFrame: curSpriteFrame,
          },
        });
      }
    }

    // Advance nested animated sprites
    for (const [depth, entry] of this.displayList.entries()) {
      if (this.swf.sprites.has(entry.characterId)) {
        const sprite = this.swf.sprites.get(entry.characterId)!;
        if (sprite.frames.length > 1) {
          const spriteKey = `${depth}_${entry.characterId}`;
          const next = ((this.spriteFrames.get(spriteKey) ?? 0) + 1) % sprite.frames.length;
          this.spriteFrames.set(spriteKey, next);
          if (entry.spriteState) {
            entry.spriteState.currentFrame = next;
          }
        }
      }
    }

    this.render();
  }

  public render(): void {
    const { width, height } = this.swf.frameSize;
    const bg = this.swf.backgroundColor;

    // Reset transform
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Clear background
    this.ctx.fillStyle = `rgb(${bg.r}, ${bg.g}, ${bg.b})`;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Coordinate scale from SWF stage to Canvas resolution
    const scaleFactorX = this.canvas.width / (width || 550);
    const scaleFactorY = this.canvas.height / (height || 400);

    this.ctx.save();
    this.ctx.scale(scaleFactorX, scaleFactorY);

    // Sort display list by depth ascending
    const sortedDepths = Array.from(this.displayList.keys()).sort((a, b) => a - b);
    const clipStack: number[] = [];

    for (const depth of sortedDepths) {
      const entry = this.displayList.get(depth)!;

      // Pop all clipping scopes that have ended before this depth
      while (clipStack.length > 0 && depth > clipStack[clipStack.length - 1]) {
        this.ctx.restore();
        clipStack.pop();
      }

      // Check if this depth defines a mask layer (clipDepth > depth)
      if (entry.clipDepth && entry.clipDepth > depth) {
        const masked = this.applyMask(
          entry.characterId,
          entry.matrix,
          entry.ratio,
          entry.spriteState?.currentFrame ?? 0
        );
        if (masked) {
          clipStack.push(entry.clipDepth);
        }
        // In Flash, the mask layer itself is not rendered as visible graphics
        continue;
      }

      this.renderCharacter(
        entry.characterId,
        entry.matrix,
        entry.colorTransform,
        false,
        entry.spriteState?.currentFrame ?? 0,
        entry.ratio
      );
    }

    while (clipStack.length > 0) {
      this.ctx.restore();
      clipStack.pop();
    }

    // PAUSED MODE: Render visual selection & drag indicators
    if (this.isPaused) {
      const activeDepth = this.dragState?.isDragging ? this.dragState.depth : this.hoveredAssetInfo?.depth;
      if (activeDepth !== undefined && activeDepth !== null) {
        const entry = this.displayList.get(activeDepth);
        if (entry && entry.characterId) {
          const bounds = this.getCharacterBounds(entry.characterId);
          if (bounds) {
            this.ctx.save();
            this.applyMatrix(entry.matrix);

            const isDragging = !!this.dragState?.isDragging;
            this.ctx.strokeStyle = isDragging ? '#f59e0b' : '#38bdf8';
            this.ctx.lineWidth = isDragging ? 2 : 1.5;
            this.ctx.setLineDash(isDragging ? [5, 3] : [3, 3]);

            const pad = 3;
            const rx = bounds.xmin - pad;
            const ry = bounds.ymin - pad;
            const rw = bounds.width + pad * 2;
            const rh = bounds.height + pad * 2;

            this.ctx.strokeRect(rx, ry, rw, rh);

            // 4 Corner handles
            this.ctx.setLineDash([]);
            this.ctx.fillStyle = isDragging ? '#f59e0b' : '#38bdf8';
            const h = 5;
            this.ctx.fillRect(rx - h / 2, ry - h / 2, h, h);
            this.ctx.fillRect(rx + rw - h / 2, ry - h / 2, h, h);
            this.ctx.fillRect(rx - h / 2, ry + rh - h / 2, h, h);
            this.ctx.fillRect(rx + rw - h / 2, ry + rh - h / 2, h, h);

            this.ctx.restore();
          }
        }
      }
    }

    this.ctx.restore();
  }

  private renderCharacter(
    characterId: number,
    matrix: SwfMatrix,
    colorTransform?: SwfColorTransform,
    asMask = false,
    spriteFrameIndex = 0,
    ratio?: number
  ): void {
    if (!characterId) return;

    this.ctx.save();
    this.applyMatrix(matrix);

    let alpha = 1;
    if (colorTransform && colorTransform.hasMult && colorTransform.multA !== undefined) {
      alpha = Math.max(0, Math.min(1, colorTransform.multA));
    }
    this.ctx.globalAlpha *= alpha;

    if (this.swf.morphShapes?.has(characterId)) {
      const morph = this.swf.morphShapes.get(characterId)!;
      const t = ratio !== undefined ? Math.max(0, Math.min(1, ratio / 65535.0)) : 0;
      this.renderMorphShape(morph, t, asMask, colorTransform);
    } else if (this.swf.shapes.has(characterId)) {
      const shape = this.swf.shapes.get(characterId)!;
      this.renderShape(shape, asMask, colorTransform);
    } else if (this.swf.bitmaps.has(characterId)) {
      const bitmap = this.swf.bitmaps.get(characterId)!;
      this.renderBitmap(bitmap);
    } else if (this.swf.texts.has(characterId)) {
      const text = this.swf.texts.get(characterId)!;
      this.renderText(text, colorTransform);
    } else if (this.swf.sprites.has(characterId)) {
      const sprite = this.swf.sprites.get(characterId)!;
      this.renderSprite(sprite, spriteFrameIndex, colorTransform);
    } else if (this.swf.buttons.has(characterId)) {
      const button = this.swf.buttons.get(characterId)!;
      this.renderButton(button, colorTransform);
    } else if (this.swf.videoStreams?.has(characterId)) {
      const videoStream = this.swf.videoStreams.get(characterId)!;
      this.renderVideoStream(videoStream, spriteFrameIndex);
    }

    this.ctx.restore();
  }

  private interpolateMorphShape(morph: SwfMorphShape, t: number): SwfShape {
    return computeMorphShape(morph, t);
  }

  private renderMorphShape(
    morph: SwfMorphShape,
    t: number,
    asMask = false,
    colorTransform?: SwfColorTransform
  ): void {
    const interpolatedShape = this.interpolateMorphShape(morph, t);
    this.renderShape(interpolatedShape, asMask, colorTransform);
  }

  private transformPoint(matrix: SwfMatrix, x: number, y: number): { x: number; y: number } {
    const a = matrix.scaleX ?? 1;
    const b = matrix.rotateSkew0 ?? 0;
    const c = matrix.rotateSkew1 ?? 0;
    const d = matrix.scaleY ?? 1;
    const tx = matrix.translateX ?? 0;
    const ty = matrix.translateY ?? 0;
    return {
      x: a * x + c * y + tx,
      y: b * x + d * y + ty,
    };
  }

  private multiplyMatrices(m1: SwfMatrix, m2: SwfMatrix): SwfMatrix {
    const a1 = m1.scaleX ?? 1;
    const b1 = m1.rotateSkew0 ?? 0;
    const c1 = m1.rotateSkew1 ?? 0;
    const d1 = m1.scaleY ?? 1;
    const tx1 = m1.translateX ?? 0;
    const ty1 = m1.translateY ?? 0;

    const a2 = m2.scaleX ?? 1;
    const b2 = m2.rotateSkew0 ?? 0;
    const c2 = m2.rotateSkew1 ?? 0;
    const d2 = m2.scaleY ?? 1;
    const tx2 = m2.translateX ?? 0;
    const ty2 = m2.translateY ?? 0;

    return {
      hasScale: true,
      scaleX: a1 * a2 + c1 * b2,
      hasRotate: true,
      rotateSkew0: b1 * a2 + d1 * b2,
      rotateSkew1: a1 * c2 + c1 * d2,
      scaleY: b1 * c2 + d1 * d2,
      translateX: a1 * tx2 + c1 * ty2 + tx1,
      translateY: b1 * tx2 + d1 * ty2 + ty1,
    };
  }

  /**
   * Builds and activates an exact Flash vector clipping mask in the current graphics state.
   */
  private applyMask(
    characterId: number,
    matrix: SwfMatrix,
    ratio?: number,
    spriteFrameIndex = 0
  ): boolean {
    this.ctx.save();
    this.ctx.beginPath();

    const hasPath = this.addCharacterToMaskPath(characterId, matrix, ratio, spriteFrameIndex);
    if (hasPath) {
      this.ctx.clip('evenodd');
      return true;
    } else {
      this.ctx.restore();
      return false;
    }
  }

  private addCharacterToMaskPath(
    characterId: number,
    matrix: SwfMatrix,
    ratio?: number,
    spriteFrameIndex = 0
  ): boolean {
    if (!characterId) return false;

    if (this.swf.morphShapes?.has(characterId)) {
      const morph = this.swf.morphShapes.get(characterId)!;
      const t = ratio !== undefined ? Math.max(0, Math.min(1, ratio / 65535.0)) : 0;
      const shape = this.interpolateMorphShape(morph, t);
      return this.addShapeToMaskPath(shape, matrix);
    }

    if (this.swf.shapes.has(characterId)) {
      const shape = this.swf.shapes.get(characterId)!;
      return this.addShapeToMaskPath(shape, matrix);
    }

    if (this.swf.sprites.has(characterId)) {
      const sprite = this.swf.sprites.get(characterId)!;
      if (!sprite.frames || sprite.frames.length === 0) return false;
      const frameIdx = spriteFrameIndex % sprite.frames.length;
      const sFrame = sprite.frames[frameIdx];
      if (!sFrame || !sFrame.displaySnapshot) return false;

      let added = false;
      const sortedDepths = Array.from(sFrame.displaySnapshot.keys()).sort((a, b) => a - b);
      for (const d of sortedDepths) {
        const sub = sFrame.displaySnapshot.get(d)!;
        const subMatrix = this.multiplyMatrices(matrix, sub.matrix);
        if (this.addCharacterToMaskPath(sub.characterId, subMatrix, sub.ratio, 0)) {
          added = true;
        }
      }
      return added;
    }

    if (this.swf.buttons.has(characterId)) {
      const button = this.swf.buttons.get(characterId)!;
      let added = false;
      for (const rec of button.characters) {
        const subMatrix = this.multiplyMatrices(matrix, rec.matrix);
        if (this.addCharacterToMaskPath(rec.characterId, subMatrix, ratio, 0)) {
          added = true;
        }
      }
      return added;
    }

    // Fallback for Bitmaps, Texts, and Video Streams: use transformed bounding box
    const bounds = this.getCharacterBounds(characterId);
    if (bounds) {
      const p0 = this.transformPoint(matrix, bounds.xmin, bounds.ymin);
      const p1 = this.transformPoint(matrix, bounds.xmax, bounds.ymin);
      const p2 = this.transformPoint(matrix, bounds.xmax, bounds.ymax);
      const p3 = this.transformPoint(matrix, bounds.xmin, bounds.ymax);

      this.ctx.moveTo(p0.x, p0.y);
      this.ctx.lineTo(p1.x, p1.y);
      this.ctx.lineTo(p2.x, p2.y);
      this.ctx.lineTo(p3.x, p3.y);
      this.ctx.closePath();
      return true;
    }

    return false;
  }

  private addShapeToMaskPath(shape: SwfShape, matrix: SwfMatrix): boolean {
    if (!shape.paths || shape.paths.length === 0) return false;

    let cmdCount = 0;
    for (const path of shape.paths) {
      if (!path.commands || path.commands.length === 0) continue;

      for (const cmd of path.commands) {
        if (cmd.type === 'moveTo') {
          const pt = this.transformPoint(matrix, cmd.x, cmd.y);
          this.ctx.moveTo(pt.x, pt.y);
          cmdCount++;
        } else if (cmd.type === 'lineTo') {
          const pt = this.transformPoint(matrix, cmd.x, cmd.y);
          this.ctx.lineTo(pt.x, pt.y);
          cmdCount++;
        } else if (cmd.type === 'curveTo') {
          const cp = this.transformPoint(matrix, cmd.cx, cmd.cy);
          const ap = this.transformPoint(matrix, cmd.ax, cmd.ay);
          this.ctx.quadraticCurveTo(cp.x, cp.y, ap.x, ap.y);
          cmdCount++;
        }
      }
    }

    return cmdCount > 0;
  }

  private applyMatrix(matrix: SwfMatrix): void {
    const a = matrix.scaleX ?? 1;
    const b = matrix.rotateSkew0 ?? 0;
    const c = matrix.rotateSkew1 ?? 0;
    const d = matrix.scaleY ?? 1;
    const tx = matrix.translateX ?? 0;
    const ty = matrix.translateY ?? 0;
    this.ctx.transform(a, b, c, d, tx, ty);
  }

  public applyColorTransform(color: SwfColorRGBA, ct?: SwfColorTransform): SwfColorRGBA {
    if (!ct) return color;
    const multR = ct.hasMult ? (ct.multR ?? 1) : 1;
    const multG = ct.hasMult ? (ct.multG ?? 1) : 1;
    const multB = ct.hasMult ? (ct.multB ?? 1) : 1;
    const multA = ct.hasMult ? (ct.multA ?? 1) : 1;

    const addR = ct.hasAdd ? (ct.addR ?? 0) : 0;
    const addG = ct.hasAdd ? (ct.addG ?? 0) : 0;
    const addB = ct.hasAdd ? (ct.addB ?? 0) : 0;
    const addA = ct.hasAdd ? (ct.addA ?? 0) : 0;

    const r = Math.round(Math.max(0, Math.min(255, color.r * multR + addR)));
    const g = Math.round(Math.max(0, Math.min(255, color.g * multG + addG)));
    const b = Math.round(Math.max(0, Math.min(255, color.b * multB + addB)));
    const a = Math.max(0, Math.min(1, color.a * multA + addA / 255.0));

    return { r, g, b, a };
  }

  public combineColorTransforms(parent?: SwfColorTransform, child?: SwfColorTransform): SwfColorTransform | undefined {
    if (!parent && !child) return undefined;
    if (!parent) return child;
    if (!child) return parent;

    const pMultR = parent.hasMult ? parent.multR : 1;
    const pMultG = parent.hasMult ? parent.multG : 1;
    const pMultB = parent.hasMult ? parent.multB : 1;
    const pMultA = parent.hasMult ? parent.multA : 1;
    const pAddR = parent.hasAdd ? parent.addR : 0;
    const pAddG = parent.hasAdd ? parent.addG : 0;
    const pAddB = parent.hasAdd ? parent.addB : 0;
    const pAddA = parent.hasAdd ? parent.addA : 0;

    const cMultR = child.hasMult ? child.multR : 1;
    const cMultG = child.hasMult ? child.multG : 1;
    const cMultB = child.hasMult ? child.multB : 1;
    const cMultA = child.hasMult ? child.multA : 1;
    const cAddR = child.hasAdd ? child.addR : 0;
    const cAddG = child.hasAdd ? child.addG : 0;
    const cAddB = child.hasAdd ? child.addB : 0;
    const cAddA = child.hasAdd ? child.addA : 0;

    return {
      hasMult: parent.hasMult || child.hasMult,
      hasAdd: parent.hasAdd || child.hasAdd,
      multR: pMultR * cMultR,
      multG: pMultG * cMultG,
      multB: pMultB * cMultB,
      multA: pMultA * cMultA,
      addR: pAddR + cAddR * pMultR,
      addG: pAddG + cAddG * pMultG,
      addB: pAddB + cAddB * pMultB,
      addA: pAddA + cAddA * pMultA,
    };
  }

  private splitPathIntoRuns(commands: SwfDrawCommand[]): {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    cmds: SwfDrawCommand[];
  }[] {
    const runs: {
      startX: number;
      startY: number;
      endX: number;
      endY: number;
      cmds: SwfDrawCommand[];
    }[] = [];

    let curX = 0;
    let curY = 0;
    let runStartX = 0;
    let runStartY = 0;
    let runCmds: SwfDrawCommand[] = [];
    let hasStart = false;

    for (const cmd of commands) {
      if (cmd.type === 'moveTo') {
        if (hasStart && runCmds.length > 0) {
          runs.push({
            startX: runStartX,
            startY: runStartY,
            endX: curX,
            endY: curY,
            cmds: runCmds,
          });
        }
        curX = cmd.x;
        curY = cmd.y;
        runStartX = curX;
        runStartY = curY;
        runCmds = [];
        hasStart = true;
      } else if (cmd.type === 'lineTo') {
        if (!hasStart) {
          runStartX = cmd.x;
          runStartY = cmd.y;
          hasStart = true;
        } else {
          runCmds.push(cmd);
        }
        curX = cmd.x;
        curY = cmd.y;
      } else if (cmd.type === 'curveTo') {
        if (!hasStart) {
          runStartX = cmd.ax;
          runStartY = cmd.ay;
          hasStart = true;
        } else {
          runCmds.push(cmd);
        }
        curX = cmd.ax;
        curY = cmd.ay;
      }
    }

    if (hasStart && runCmds.length > 0) {
      runs.push({
        startX: runStartX,
        startY: runStartY,
        endX: curX,
        endY: curY,
        cmds: runCmds,
      });
    }

    return runs;
  }

  private extractDirectedEdges(
    paths: SwfShapePath[],
    fillIdx: number
  ): {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    commands: SwfDrawCommand[];
  }[] {
    const edges: {
      startX: number;
      startY: number;
      endX: number;
      endY: number;
      commands: SwfDrawCommand[];
    }[] = [];

    for (const path of paths) {
      if (!path.commands || path.commands.length === 0) continue;

      const isFwd = path.fillStyle1 === fillIdx && path.fillStyle0 !== fillIdx;
      const isRev = path.fillStyle0 === fillIdx && path.fillStyle1 !== fillIdx;

      if (!isFwd && !isRev) continue;

      const runs = this.splitPathIntoRuns(path.commands);
      for (const run of runs) {
        if (isFwd) {
          edges.push({
            startX: run.startX,
            startY: run.startY,
            endX: run.endX,
            endY: run.endY,
            commands: run.cmds,
          });
        }

        if (isRev) {
          const revCmds: SwfDrawCommand[] = [];
          const segs: {
            type: 'lineTo' | 'curveTo';
            x0: number;
            y0: number;
            x1: number;
            y1: number;
            cx?: number;
            cy?: number;
          }[] = [];

          let px = run.startX;
          let py = run.startY;

          for (const c of run.cmds) {
            if (c.type === 'lineTo') {
              segs.push({ type: 'lineTo', x0: px, y0: py, x1: c.x, y1: c.y });
              px = c.x;
              py = c.y;
            } else if (c.type === 'curveTo') {
              segs.push({
                type: 'curveTo',
                x0: px,
                y0: py,
                x1: c.ax,
                y1: c.ay,
                cx: c.cx,
                cy: c.cy,
              });
              px = c.ax;
              py = c.ay;
            }
          }

          for (let s = segs.length - 1; s >= 0; s--) {
            const seg = segs[s];
            if (seg.type === 'lineTo') {
              revCmds.push({ type: 'lineTo', x: seg.x0, y: seg.y0 });
            } else {
              revCmds.push({
                type: 'curveTo',
                cx: seg.cx!,
                cy: seg.cy!,
                ax: seg.x0,
                ay: seg.y0,
              });
            }
          }

          edges.push({
            startX: run.endX,
            startY: run.endY,
            endX: run.startX,
            endY: run.startY,
            commands: revCmds,
          });
        }
      }
    }

    return edges;
  }

  private renderStitchedFill(
    edges: {
      startX: number;
      startY: number;
      endX: number;
      endY: number;
      commands: SwfDrawCommand[];
    }[]
  ): void {
    if (edges.length === 0) return;

    const used = new Uint8Array(edges.length);
    const EPSILON = 0.5;

    for (let i = 0; i < edges.length; i++) {
      if (used[i]) continue;
      used[i] = 1;

      const first = edges[i];
      const loopStartX = first.startX;
      const loopStartY = first.startY;

      this.ctx.moveTo(loopStartX, loopStartY);
      this.drawEdgeCommands(first.commands);

      let curX = first.endX;
      let curY = first.endY;

      while (true) {
        const dToStart = Math.hypot(curX - loopStartX, curY - loopStartY);
        if (dToStart < EPSILON) {
          this.ctx.closePath();
          break;
        }

        let bestIdx = -1;
        let bestDist = 2.0; // 2px connecting tolerance
        for (let j = 0; j < edges.length; j++) {
          if (!used[j]) {
            const d = Math.hypot(curX - edges[j].startX, curY - edges[j].startY);
            if (d < bestDist) {
              bestDist = d;
              bestIdx = j;
            }
          }
        }

        if (bestIdx !== -1) {
          used[bestIdx] = 1;
          const nextEdge = edges[bestIdx];
          if (bestDist > 0.001) {
            this.ctx.lineTo(nextEdge.startX, nextEdge.startY);
          }
          this.drawEdgeCommands(nextEdge.commands);
          curX = nextEdge.endX;
          curY = nextEdge.endY;
        } else {
          this.ctx.closePath();
          break;
        }
      }
    }
  }

  private drawEdgeCommands(commands: SwfDrawCommand[]): void {
    for (const cmd of commands) {
      if (cmd.type === 'lineTo') {
        this.ctx.lineTo(cmd.x, cmd.y);
      } else if (cmd.type === 'curveTo') {
        this.ctx.quadraticCurveTo(cmd.cx, cmd.cy, cmd.ax, cmd.ay);
      }
    }
  }

  /**
   * High-Fidelity Contour-Stitched Vector Shape Renderer:
   * Pass 1: Stitches directed boundary edges into closed loops per fill style and fills using even-odd rule.
   * Pass 2: Strokes line styles cleanly with exact color transform.
   */
  private renderShape(
    shape: SwfShape,
    asMask = false,
    colorTransform?: SwfColorTransform
  ): void {
    if (!shape.paths || shape.paths.length === 0) return;

    if (asMask) {
      this.ctx.beginPath();
      let hasMaskEdges = false;
      const numFills = shape.fillStyles.length;
      for (let fillIdx = 1; fillIdx <= numFills; fillIdx++) {
        const edges = this.extractDirectedEdges(shape.paths, fillIdx);
        if (edges.length > 0) {
          hasMaskEdges = true;
          this.renderStitchedFill(edges);
        }
      }
      if (!hasMaskEdges) {
        for (const path of shape.paths) {
          this.drawCommandsForward(path.commands);
        }
      }
      this.ctx.clip();
      return;
    }

    // PASS 1: FILLS (Grouped by fillStyle index, stitched into continuous loops)
    const numFills = shape.fillStyles.length;
    for (let fillIdx = 1; fillIdx <= numFills; fillIdx++) {
      const fillStyle = shape.fillStyles[fillIdx - 1];
      const edges = this.extractDirectedEdges(shape.paths, fillIdx);
      if (edges.length === 0) continue;

      this.ctx.save();
      this.applyFillStyle(fillStyle, colorTransform);
      this.ctx.beginPath();
      this.renderStitchedFill(edges);
      this.ctx.fill('evenodd');
      this.ctx.restore();
    }

    // PASS 2: STROKES / LINES (Grouped by lineStyle index)
    const numLines = shape.lineStyles.length;
    for (let lineIdx = 1; lineIdx <= numLines; lineIdx++) {
      const lineStyle = shape.lineStyles[lineIdx - 1];
      const c = this.applyColorTransform(lineStyle.color, colorTransform);

      this.ctx.save();
      this.ctx.strokeStyle = `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
      this.ctx.lineWidth = Math.max(0.5, lineStyle.width);
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this.ctx.beginPath();

      let hasCommandsForLine = false;
      for (const path of shape.paths) {
        if (path.lineStyle === lineIdx) {
          hasCommandsForLine = true;
          for (const cmd of path.commands) {
            if (cmd.type === 'moveTo') {
              this.ctx.moveTo(cmd.x, cmd.y);
            } else if (cmd.type === 'lineTo') {
              this.ctx.lineTo(cmd.x, cmd.y);
            } else if (cmd.type === 'curveTo') {
              this.ctx.quadraticCurveTo(cmd.cx, cmd.cy, cmd.ax, cmd.ay);
            }
          }
        }
      }

      if (hasCommandsForLine) {
        this.ctx.stroke();
      }
      this.ctx.restore();
    }
  }

  private drawCommandsForward(commands: SwfDrawCommand[]): void {
    let hasMoveTo = false;
    for (const cmd of commands) {
      if (cmd.type === 'moveTo') {
        this.ctx.moveTo(cmd.x, cmd.y);
        hasMoveTo = true;
      } else if (cmd.type === 'lineTo') {
        if (!hasMoveTo) {
          this.ctx.moveTo(cmd.x, cmd.y);
          hasMoveTo = true;
        } else {
          this.ctx.lineTo(cmd.x, cmd.y);
        }
      } else if (cmd.type === 'curveTo') {
        if (!hasMoveTo) {
          this.ctx.moveTo(cmd.ax, cmd.ay);
          hasMoveTo = true;
        } else {
          this.ctx.quadraticCurveTo(cmd.cx, cmd.cy, cmd.ax, cmd.ay);
        }
      }
    }
  }

  private applyFillStyle(style: SwfFillStyle, colorTransform?: SwfColorTransform): void {
    if (style.type === 'solid' && style.color) {
      const c = this.applyColorTransform(style.color, colorTransform);
      this.ctx.fillStyle = `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
    } else if (
      (style.type === 'linearGradient' || style.type === 'radialGradient') &&
      style.gradients &&
      style.gradients.length > 0
    ) {
      const gm = style.gradientMatrix || {
        hasScale: false,
        scaleX: 1,
        scaleY: 1,
        hasRotate: false,
        rotateSkew0: 0,
        rotateSkew1: 0,
        translateX: 0,
        translateY: 0,
      };

      const a = gm.scaleX ?? 1;
      const b = gm.rotateSkew0 ?? 0;
      const c = gm.rotateSkew1 ?? 0;
      const d = gm.scaleY ?? 1;
      const tx = gm.translateX ?? 0;
      const ty = gm.translateY ?? 0;

      let grad: CanvasGradient;

      if (style.type === 'linearGradient') {
        // Flash standard linear gradient maps (-819.2, 0) to (819.2, 0) in pixels (-16384 to 16384 twips)
        const x0 = -819.2 * a + tx;
        const y0 = -819.2 * b + ty;
        let x1 = 819.2 * a + tx;
        let y1 = 819.2 * b + ty;

        // Ensure distinct endpoints for canvas gradient
        if (Math.abs(x1 - x0) < 0.001 && Math.abs(y1 - y0) < 0.001) {
          x1 += 0.01;
        }

        grad = this.ctx.createLinearGradient(x0, y0, x1, y1);
      } else {
        // Flash standard radial gradient has center (0, 0) and radius 819.2 pixels
        const xc = tx;
        const yc = ty;
        const r = Math.max(0.1, 819.2 * Math.sqrt((a * a + b * b + c * c + d * d) / 2));

        grad = this.ctx.createRadialGradient(xc, yc, 0, xc, yc, r);
      }

      // Sort gradient stops by ratio ascending and apply colorTransform
      const sortedStops = [...style.gradients].sort((s1, s2) => s1.ratio - s2.ratio);
      for (const rec of sortedStops) {
        const stop = Math.max(0, Math.min(1, rec.ratio / 255.0));
        const clr = this.applyColorTransform(rec.color, colorTransform);
        grad.addColorStop(stop, `rgba(${clr.r}, ${clr.g}, ${clr.b}, ${clr.a})`);
      }

      this.ctx.fillStyle = grad;
    } else if (style.type === 'bitmap' && style.bitmapId) {
      const bmp = this.swf.bitmaps.get(style.bitmapId);
      const source: CanvasImageSource | null =
        bmp?.canvasElement ||
        (bmp?.imageElement && bmp.imageElement.complete && bmp.imageElement.naturalWidth > 0
          ? bmp.imageElement
          : null);

      if (source) {
        const pattern = this.ctx.createPattern(source, style.repeat ? 'repeat' : 'no-repeat');
        if (pattern) {
          if (style.bitmapMatrix && typeof (pattern as any).setTransform === 'function') {
            try {
              const bm = style.bitmapMatrix;
              const scaleX = (bm.scaleX !== undefined ? bm.scaleX : 20.0) / 20.0;
              const scaleY = (bm.scaleY !== undefined ? bm.scaleY : 20.0) / 20.0;
              const skew0 = (bm.rotateSkew0 ?? 0) / 20.0;
              const skew1 = (bm.rotateSkew1 ?? 0) / 20.0;
              const tx = bm.translateX ?? 0;
              const ty = bm.translateY ?? 0;

              const domMatrix = new DOMMatrix([scaleX, skew0, skew1, scaleY, tx, ty]);
              (pattern as any).setTransform(domMatrix);
            } catch {
              // ignore transform failure
            }
          }
          this.ctx.fillStyle = pattern;
        }
      }
    }
  }

  private renderBitmap(bitmap: SwfBitmap): void {
    const source: CanvasImageSource | null =
      bitmap.canvasElement ||
      (bitmap.imageElement && bitmap.imageElement.complete && bitmap.imageElement.naturalWidth > 0
        ? bitmap.imageElement
        : null);

    if (source) {
      this.ctx.drawImage(source, 0, 0);
    }
  }

  private renderText(text: SwfText, colorTransform?: SwfColorTransform): void {
    this.ctx.save();

    if (text.matrix) {
      this.applyMatrix(text.matrix);
    }

    // CASE 1: Dynamic / Input Edit Text (DefineEditText)
    if (text.initialText && (!text.textRecords || text.textRecords.length === 0)) {
      let rawText = fixMojibake(text.initialText);
      const c = this.applyColorTransform(text.color || { r: 0, g: 0, b: 0, a: 1 }, colorTransform);
      let displayColor = `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
      let fontSize = text.fontHeight || 14;

      // Extract attributes from HTML if present
      if (text.isHtml || rawText.includes('<')) {
        const colorMatch = rawText.match(/color=["']#?([0-9a-fA-F]{6})["']/i);
        if (colorMatch) {
          displayColor = `#${colorMatch[1]}`;
        }
        const sizeMatch = rawText.match(/size=["'](\d+)["']/i);
        if (sizeMatch) {
          fontSize = Math.max(8, parseInt(sizeMatch[1], 10));
        }
        // Strip HTML tags for clean text rendering
        rawText = rawText.replace(/<[^>]+>/g, '').trim();
      }

      const font = text.fontId !== undefined ? this.swf.fonts.get(text.fontId) : undefined;
      const fontName = font?.name ? `"${font.name}", ` : '';
      const fontWeight = font?.isBold ? 'bold ' : '';
      const fontStyle = font?.isItalic ? 'italic ' : '';

      this.ctx.font = `${fontStyle}${fontWeight}${Math.round(fontSize)}px ${fontName}"Meiryo", "MS PGothic", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Segoe UI", Arial, sans-serif`;
      this.ctx.fillStyle = displayColor;
      this.ctx.textBaseline = 'top';

      const tx = text.bounds ? text.bounds.xmin / 20.0 : 0;
      const ty = text.bounds ? text.bounds.ymin / 20.0 : 0;
      const boxWidth = text.bounds ? Math.max(20, text.bounds.width) : 200;

      let drawX = tx;
      if (text.align === 1) {
        this.ctx.textAlign = 'right';
        drawX = tx + boxWidth;
      } else if (text.align === 2) {
        this.ctx.textAlign = 'center';
        drawX = tx + boxWidth / 2;
      } else {
        this.ctx.textAlign = 'left';
      }

      const lines = rawText.split(/\r\n|\r|\n/);
      let lineY = ty;
      const lineHeight = fontSize * 1.25;

      for (const line of lines) {
        if (line) {
          this.ctx.fillText(line, drawX, lineY);
        }
        lineY += lineHeight;
      }

      this.ctx.restore();
      return;
    }

    // CASE 2: Static Text (DefineText / DefineText2)
    if (text.textRecords && text.textRecords.length > 0) {
      let curX = 0;
      let curY = 0;

      for (const rec of text.textRecords) {
        if (rec.hasXOffset && rec.xOffset !== undefined) {
          curX = rec.xOffset;
        }
        if (rec.hasYOffset && rec.yOffset !== undefined) {
          curY = rec.yOffset;
        }

        const font = rec.fontId !== undefined ? this.swf.fonts.get(rec.fontId) : undefined;
        const fontName = font?.name ? `"${font.name}", ` : '';
        const fontSize = Math.max(6, Math.round(rec.textHeight || 12));
        const fontWeight = font?.isBold ? 'bold ' : '';
        const fontStyle = font?.isItalic ? 'italic ' : '';

        this.ctx.font = `${fontStyle}${fontWeight}${fontSize}px ${fontName}"Meiryo", "MS PGothic", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Segoe UI", Arial, sans-serif`;
        this.ctx.textBaseline = 'alphabetic';
        this.ctx.textAlign = 'left';

        const c = this.applyColorTransform(rec.color || { r: 255, g: 255, b: 255, a: 1 }, colorTransform);
        this.ctx.fillStyle = `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;

        for (const ge of rec.glyphEntries) {
          let char = '';
          if (font && font.codeTable && font.codeTable[ge.glyphIndex] !== undefined) {
            const code = font.codeTable[ge.glyphIndex];
            if (code > 0) char = decodeCharCode(code, font.isShiftJIS);
          } else if (ge.glyphIndex >= 32 && ge.glyphIndex <= 126) {
            char = String.fromCharCode(ge.glyphIndex);
          }

          const glyphShape = font?.glyphShapes?.[ge.glyphIndex];
          if (glyphShape && glyphShape.paths && glyphShape.paths.length > 0) {
            // Render SWF embedded vector glyph using SWF font outline points
            this.ctx.save();
            this.ctx.translate(curX, curY);
            const scale = font.tagCode === 75 ? fontSize / 1024.0 : fontSize / 51.2;
            this.ctx.scale(scale, scale);
            this.renderGlyphShape(glyphShape, c);
            this.ctx.restore();
          } else if (char) {
            this.ctx.fillText(char, curX, curY);
          }

          const adv = ge.advance !== 0 ? ge.advance : fontSize * 0.6;
          curX += adv;
        }
      }
    }

    this.ctx.restore();
  }

  private renderGlyphShape(glyphShape: SwfShape, color: SwfColorRGBA): void {
    if (!glyphShape.paths || glyphShape.paths.length === 0) return;

    this.ctx.save();
    this.ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a})`;
    this.ctx.beginPath();
    for (const path of glyphShape.paths) {
      this.drawCommandsForward(path.commands);
    }
    this.ctx.fill('evenodd');
    this.ctx.restore();
  }

  private renderSprite(sprite: SwfSprite, frameIndex: number, parentColorTransform?: SwfColorTransform): void {
    if (!sprite.frames || sprite.frames.length === 0) return;
    const clampedFrame = frameIndex % sprite.frames.length;
    const sFrame = sprite.frames[clampedFrame];
    if (!sFrame || !sFrame.displaySnapshot) return;

    const sortedDepths = Array.from(sFrame.displaySnapshot.keys()).sort((a, b) => a - b);
    const clipStack: number[] = [];

    for (const depth of sortedDepths) {
      const entry = sFrame.displaySnapshot.get(depth)!;

      // Pop active clips that have ended
      while (clipStack.length > 0 && depth > clipStack[clipStack.length - 1]) {
        this.ctx.restore();
        clipStack.pop();
      }

      // Check if this depth is a mask
      if (entry.clipDepth && entry.clipDepth > depth) {
        const masked = this.applyMask(entry.characterId, entry.matrix, entry.ratio, 0);
        if (masked) {
          clipStack.push(entry.clipDepth);
        }
        continue;
      }

      const combined = this.combineColorTransforms(parentColorTransform, entry.colorTransform);
      this.renderCharacter(entry.characterId, entry.matrix, combined, false, 0, entry.ratio);
    }

    while (clipStack.length > 0) {
      this.ctx.restore();
      clipStack.pop();
    }
  }

  private renderButton(button: SwfButton, parentColorTransform?: SwfColorTransform): void {
    const isHovered = this.hoveredButtonId === button.id;
    const isDown = isHovered && this.isPointerDown;

    for (const record of button.characters) {
      let shouldRender = false;
      if (isDown && record.stateDown) {
        shouldRender = true;
      } else if (isHovered && !isDown && record.stateOver) {
        shouldRender = true;
      } else if (!isHovered && record.stateUp) {
        shouldRender = true;
      }

      if (shouldRender) {
        const combined = this.combineColorTransforms(parentColorTransform, record.colorTransform);
        this.renderCharacter(record.characterId, record.matrix, combined);
      }
    }
  }

  private renderVideoStream(stream: SwfVideoStream, spriteFrameIndex = 0): void {
    // Determine the video frame index
    let targetFrame = spriteFrameIndex > 0 ? spriteFrameIndex : this.currentFrameIndex;
    if (stream.numFrames > 0) {
      targetFrame = targetFrame % stream.numFrames;
    }

    const canvas = VideoDecoderEngine.getFrameSync(stream, targetFrame) || stream.currentDecodedCanvas;

    if (canvas) {
      this.ctx.imageSmoothingEnabled = stream.smoothing;
      this.ctx.drawImage(canvas, 0, 0, stream.width, stream.height);
    }
  }

  public getCharacterBounds(characterId: number): {
    xmin: number;
    ymin: number;
    xmax: number;
    ymax: number;
    width: number;
    height: number;
  } | null {
    if (this.swf.morphShapes?.has(characterId)) {
      const morph = this.swf.morphShapes.get(characterId)!;
      const xmin = Math.min(morph.startBounds.xmin, morph.endBounds.xmin) / 20.0;
      const xmax = Math.max(morph.startBounds.xmax, morph.endBounds.xmax) / 20.0;
      const ymin = Math.min(morph.startBounds.ymin, morph.endBounds.ymin) / 20.0;
      const ymax = Math.max(morph.startBounds.ymax, morph.endBounds.ymax) / 20.0;
      return {
        xmin,
        ymin,
        xmax,
        ymax,
        width: Math.max(10, xmax - xmin),
        height: Math.max(10, ymax - ymin),
      };
    }

    if (this.swf.shapes.has(characterId)) {
      const shape = this.swf.shapes.get(characterId)!;
      const xmin = shape.bounds.xmin / 20.0;
      const xmax = shape.bounds.xmax / 20.0;
      const ymin = shape.bounds.ymin / 20.0;
      const ymax = shape.bounds.ymax / 20.0;
      return {
        xmin,
        ymin,
        xmax,
        ymax,
        width: Math.max(10, xmax - xmin),
        height: Math.max(10, ymax - ymin),
      };
    }

    if (this.swf.bitmaps.has(characterId)) {
      const bmp = this.swf.bitmaps.get(characterId)!;
      return {
        xmin: 0,
        ymin: 0,
        xmax: bmp.width || 100,
        ymax: bmp.height || 100,
        width: bmp.width || 100,
        height: bmp.height || 100,
      };
    }

    if (this.swf.texts.has(characterId)) {
      const text = this.swf.texts.get(characterId)!;
      const xmin = text.bounds.xmin / 20.0;
      const xmax = text.bounds.xmax / 20.0;
      const ymin = text.bounds.ymin / 20.0;
      const ymax = text.bounds.ymax / 20.0;
      return {
        xmin,
        ymin,
        xmax,
        ymax,
        width: Math.max(10, xmax - xmin),
        height: Math.max(10, ymax - ymin),
      };
    }

    if (this.swf.sprites.has(characterId)) {
      const sprite = this.swf.sprites.get(characterId)!;
      if (sprite.frames && sprite.frames.length > 0) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const f0 = sprite.frames[0];
        if (f0 && f0.displaySnapshot) {
          for (const sub of f0.displaySnapshot.values()) {
            const subBounds = this.getCharacterBounds(sub.characterId);
            if (subBounds) {
              minX = Math.min(minX, subBounds.xmin + (sub.matrix.translateX || 0));
              minY = Math.min(minY, subBounds.ymin + (sub.matrix.translateY || 0));
              maxX = Math.max(maxX, subBounds.xmax + (sub.matrix.translateX || 0));
              maxY = Math.max(maxY, subBounds.ymax + (sub.matrix.translateY || 0));
            }
          }
        }
        if (minX !== Infinity) {
          return {
            xmin: minX,
            ymin: minY,
            xmax: maxX,
            ymax: maxY,
            width: Math.max(10, maxX - minX),
            height: Math.max(10, maxY - minY),
          };
        }
      }
      return { xmin: 0, ymin: 0, xmax: 100, ymax: 100, width: 100, height: 100 };
    }

    if (this.swf.buttons.has(characterId)) {
      const btn = this.swf.buttons.get(characterId)!;
      for (const rec of btn.characters) {
        const b = this.getCharacterBounds(rec.characterId);
        if (b) return b;
      }
    }

    if (this.swf.videoStreams?.has(characterId)) {
      const v = this.swf.videoStreams.get(characterId)!;
      return {
        xmin: 0,
        ymin: 0,
        xmax: v.width,
        ymax: v.height,
        width: Math.max(1, v.width),
        height: Math.max(1, v.height),
      };
    }

    return null;
  }

  private inverseTransformPoint(matrix: SwfMatrix, sx: number, sy: number): { x: number; y: number } {
    const a = matrix.scaleX ?? 1;
    const b = matrix.rotateSkew0 ?? 0;
    const c = matrix.rotateSkew1 ?? 0;
    const d = matrix.scaleY ?? 1;
    const tx = matrix.translateX ?? 0;
    const ty = matrix.translateY ?? 0;

    const det = a * d - b * c;
    if (Math.abs(det) < 1e-6) {
      return { x: sx - tx, y: sy - ty };
    }

    const dx = sx - tx;
    const dy = sy - ty;
    return {
      x: (d * dx - c * dy) / det,
      y: (-b * dx + a * dy) / det,
    };
  }

  public hitTestDisplayList(stageX: number, stageY: number): {
    depth: number;
    characterId: number;
    bounds: { xmin: number; ymin: number; xmax: number; ymax: number; width: number; height: number };
  } | null {
    // Sort depths descending (top-most elements first)
    const sortedDepths = Array.from(this.displayList.keys()).sort((a, b) => b - a);

    for (const depth of sortedDepths) {
      const entry = this.displayList.get(depth)!;
      if (!entry.characterId) continue;

      const bounds = this.getCharacterBounds(entry.characterId);
      if (!bounds) continue;

      const localPt = this.inverseTransformPoint(entry.matrix, stageX, stageY);
      const pad = 6;
      if (
        localPt.x >= bounds.xmin - pad &&
        localPt.x <= bounds.xmax + pad &&
        localPt.y >= bounds.ymin - pad &&
        localPt.y <= bounds.ymax + pad
      ) {
        return {
          depth,
          characterId: entry.characterId,
          bounds,
        };
      }
    }

    return null;
  }

  public resetAssetPositions(): void {
    if (this.swf.mainFrames.length === 0) return;
    this.setFrame(this.currentFrameIndex);
    this.originalMatrices.clear();
    this.dragState = null;
    this.isDraggingAsset = false;
    this.hasModifiedPositions = false;
    this.onPositionsModifiedChange?.(false);
    this.onDragStateChange?.(false, null);
    this.render();
  }

  public handlePointerMove(stageX: number, stageY: number): void {
    this.pointerX = stageX;
    this.pointerY = stageY;

    if (this.isPaused) {
      if (this.dragState?.isDragging) {
        const entry = this.displayList.get(this.dragState.depth);
        if (entry) {
          const deltaX = stageX - this.dragState.startX;
          const deltaY = stageY - this.dragState.startY;

          entry.matrix = {
            ...entry.matrix,
            translateX: this.dragState.origMatrixTx + deltaX,
            translateY: this.dragState.origMatrixTy + deltaY,
          };

          if (!this.hasModifiedPositions) {
            this.hasModifiedPositions = true;
            this.onPositionsModifiedChange?.(true);
          }

          this.render();
        }
        return;
      }

      // Hit test for hover state
      const hit = this.hitTestDisplayList(stageX, stageY);
      const nextHover = hit ? { depth: hit.depth, characterId: hit.characterId } : null;
      if (
        (this.hoveredAssetInfo === null && nextHover !== null) ||
        (this.hoveredAssetInfo !== null && nextHover === null) ||
        (this.hoveredAssetInfo && nextHover && this.hoveredAssetInfo.depth !== nextHover.depth)
      ) {
        this.hoveredAssetInfo = nextHover;
        this.onHoverAssetChange?.(nextHover);
        this.render();
      }
    } else {
      if (this.hoveredAssetInfo !== null) {
        this.hoveredAssetInfo = null;
        this.onHoverAssetChange?.(null);
      }
    }
  }

  public handlePointerDown(): boolean {
    this.isPointerDown = true;

    if (this.isPaused) {
      const hit = this.hitTestDisplayList(this.pointerX, this.pointerY);
      if (hit) {
        const entry = this.displayList.get(hit.depth)!;
        if (!this.originalMatrices.has(hit.depth)) {
          this.originalMatrices.set(hit.depth, { ...entry.matrix });
        }

        this.dragState = {
          isDragging: true,
          depth: hit.depth,
          characterId: hit.characterId,
          startX: this.pointerX,
          startY: this.pointerY,
          origMatrixTx: entry.matrix.translateX ?? 0,
          origMatrixTy: entry.matrix.translateY ?? 0,
          bounds: hit.bounds,
        };
        this.isDraggingAsset = true;
        this.onDragStateChange?.(true, { depth: hit.depth, characterId: hit.characterId });
        this.render();
        return true;
      }
    }

    this.render();
    return false;
  }

  public handlePointerUp(): void {
    this.isPointerDown = false;

    if (this.isPaused && this.dragState?.isDragging) {
      this.dragState.isDragging = false;
      this.isDraggingAsset = false;
      this.onDragStateChange?.(false, null);
      this.render();
    } else {
      this.render();
    }
  }
}
