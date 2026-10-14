/**
 * SWF Morph Shape Interpolator & Geometry Engine
 * Implements Flash-compliant linear interpolation between StartEdges and EndEdges
 * according to the SWF specification (DefineMorphShape & DefineMorphShape2).
 */

import {
  SwfDrawCommand,
  SwfFillStyle,
  SwfLineStyle,
  SwfMorphEdge,
  SwfMorphFillStyle,
  SwfMorphLineStyle,
  SwfMorphShape,
  SwfRect,
  SwfShape,
  SwfShapePath,
} from './types';

/**
 * Reconstructs a list of standard SwfShapePaths from a list of morph edges
 * at a given morph ratio t in [0, 1].
 */
export function buildPathsFromMorphEdges(morphEdges: SwfMorphEdge[], t: number): SwfShapePath[] {
  if (!morphEdges || morphEdges.length === 0) {
    return [];
  }

  const paths: SwfShapePath[] = [];
  let currentPath: SwfShapePath | null = null;
  let curPenX = 0;
  let curPenY = 0;

  for (let i = 0; i < morphEdges.length; i++) {
    const e = morphEdges[i];

    // Compute interpolated coordinates for this edge
    const x0 = e.startX0 * (1 - t) + e.endX0 * t;
    const y0 = e.startY0 * (1 - t) + e.endY0 * t;
    const cx = e.startCX * (1 - t) + e.endCX * t;
    const cy = e.startCY * (1 - t) + e.endCY * t;
    const x1 = e.startX1 * (1 - t) + e.endX1 * t;
    const y1 = e.startY1 * (1 - t) + e.endY1 * t;

    // Check if the edge is curved
    let isCurve = false;
    if (t <= 0) {
      isCurve = e.startIsCurve;
    } else if (t >= 1) {
      isCurve = e.endIsCurve;
    } else {
      isCurve = e.startIsCurve || e.endIsCurve;
    }

    // Determine if we need to begin a new path
    const penDisconnected =
      currentPath &&
      (Math.abs(curPenX - x0) > 0.05 || Math.abs(curPenY - y0) > 0.05);

    const needsNewPath =
      !currentPath ||
      e.isNewSubpath ||
      penDisconnected ||
      currentPath.fillStyle0 !== e.fillStyle0 ||
      currentPath.fillStyle1 !== e.fillStyle1 ||
      currentPath.lineStyle !== e.lineStyle;

    if (needsNewPath) {
      if (currentPath && currentPath.commands.length > 0) {
        paths.push(currentPath);
      }
      currentPath = {
        fillStyle0: e.fillStyle0,
        fillStyle1: e.fillStyle1,
        lineStyle: e.lineStyle,
        commands: [{ type: 'moveTo', x: x0, y: y0 }],
      };
      curPenX = x0;
      curPenY = y0;
    }

    if (isCurve) {
      currentPath!.commands.push({
        type: 'curveTo',
        cx,
        cy,
        ax: x1,
        ay: y1,
      });
    } else {
      currentPath!.commands.push({
        type: 'lineTo',
        x: x1,
        y: y1,
      });
    }

    curPenX = x1;
    curPenY = y1;
  }

  if (currentPath && currentPath.commands.length > 0) {
    paths.push(currentPath);
  }

  return paths;
}

/**
 * Interpolates full SwfShape geometry, fills, lines, and bounds for a morph shape.
 */
export function interpolateMorphShape(morph: SwfMorphShape, t: number): SwfShape {
  // Clamp ratio between 0 and 1
  const clampedT = Math.max(0, Math.min(1, t));

  // 1. Interpolate Bounding Box
  const sb = morph.startBounds;
  const eb = morph.endBounds;
  const bounds: SwfRect = {
    nbits: 0,
    xmin: sb.xmin * (1 - clampedT) + eb.xmin * clampedT,
    ymin: sb.ymin * (1 - clampedT) + eb.ymin * clampedT,
    xmax: sb.xmax * (1 - clampedT) + eb.xmax * clampedT,
    ymax: sb.ymax * (1 - clampedT) + eb.ymax * clampedT,
    width: sb.width * (1 - clampedT) + eb.width * clampedT,
    height: sb.height * (1 - clampedT) + eb.height * clampedT,
  };

  // 2. Interpolate Fill Styles
  const fillStyles: SwfFillStyle[] = morph.fillStyles.map((f) => {
    if (f.type === 'solid') {
      const sc = f.startColor || { r: 0, g: 0, b: 0, a: 1 };
      const ec = f.endColor || { r: 0, g: 0, b: 0, a: 1 };
      return {
        type: 'solid',
        color: {
          r: Math.round(sc.r + (ec.r - sc.r) * clampedT),
          g: Math.round(sc.g + (ec.g - sc.g) * clampedT),
          b: Math.round(sc.b + (ec.b - sc.b) * clampedT),
          a: Math.max(0, Math.min(1, sc.a + (ec.a - sc.a) * clampedT)),
        },
      };
    } else if (f.type === 'linearGradient' || f.type === 'radialGradient') {
      const sm = f.startGradientMatrix || {
        hasScale: false,
        scaleX: 1,
        scaleY: 1,
        hasRotate: false,
        rotateSkew0: 0,
        rotateSkew1: 0,
        translateX: 0,
        translateY: 0,
      };
      const em = f.endGradientMatrix || sm;
      const gm = {
        hasScale: true,
        scaleX: (sm.scaleX ?? 1) * (1 - clampedT) + (em.scaleX ?? 1) * clampedT,
        scaleY: (sm.scaleY ?? 1) * (1 - clampedT) + (em.scaleY ?? 1) * clampedT,
        hasRotate: true,
        rotateSkew0: (sm.rotateSkew0 ?? 0) * (1 - clampedT) + (em.rotateSkew0 ?? 0) * clampedT,
        rotateSkew1: (sm.rotateSkew1 ?? 0) * (1 - clampedT) + (em.rotateSkew1 ?? 0) * clampedT,
        translateX: (sm.translateX ?? 0) * (1 - clampedT) + (em.translateX ?? 0) * clampedT,
        translateY: (sm.translateY ?? 0) * (1 - clampedT) + (em.translateY ?? 0) * clampedT,
      };

      const startGrads = f.startGradients || [];
      const endGrads = f.endGradients || [];
      const count = Math.max(startGrads.length, endGrads.length);
      const gradients = [];
      for (let gi = 0; gi < count; gi++) {
        const sg =
          startGrads[gi] ||
          startGrads[startGrads.length - 1] || { ratio: 0, color: { r: 0, g: 0, b: 0, a: 1 } };
        const eg = endGrads[gi] || endGrads[endGrads.length - 1] || sg;
        gradients.push({
          ratio: Math.round(sg.ratio + (eg.ratio - sg.ratio) * clampedT),
          color: {
            r: Math.round(sg.color.r + (eg.color.r - sg.color.r) * clampedT),
            g: Math.round(sg.color.g + (eg.color.g - sg.color.g) * clampedT),
            b: Math.round(sg.color.b + (eg.color.b - sg.color.b) * clampedT),
            a: Math.max(0, Math.min(1, sg.color.a + (eg.color.a - sg.color.a) * clampedT)),
          },
        });
      }
      return {
        type: f.type,
        gradientMatrix: gm,
        gradients,
      };
    } else if (f.type === 'bitmap') {
      const sm = f.startBitmapMatrix || {
        hasScale: false,
        scaleX: 20,
        scaleY: 20,
        hasRotate: false,
        rotateSkew0: 0,
        rotateSkew1: 0,
        translateX: 0,
        translateY: 0,
      };
      const em = f.endBitmapMatrix || sm;
      const bm = {
        hasScale: true,
        scaleX: (sm.scaleX ?? 20) * (1 - clampedT) + (em.scaleX ?? 20) * clampedT,
        scaleY: (sm.scaleY ?? 20) * (1 - clampedT) + (em.scaleY ?? 20) * clampedT,
        hasRotate: true,
        rotateSkew0: (sm.rotateSkew0 ?? 0) * (1 - clampedT) + (em.rotateSkew0 ?? 0) * clampedT,
        rotateSkew1: (sm.rotateSkew1 ?? 0) * (1 - clampedT) + (em.rotateSkew1 ?? 0) * clampedT,
        translateX: (sm.translateX ?? 0) * (1 - clampedT) + (em.translateX ?? 0) * clampedT,
        translateY: (sm.translateY ?? 0) * (1 - clampedT) + (em.translateY ?? 0) * clampedT,
      };
      return {
        type: 'bitmap' as const,
        bitmapId: f.bitmapId,
        bitmapMatrix: bm,
        repeat: f.repeat,
      };
    }
    return { type: 'solid' as const };
  });

  // 3. Interpolate Line Styles
  const lineStyles: SwfLineStyle[] = morph.lineStyles.map((l) => ({
    width: Math.max(0.5, l.startWidth * (1 - clampedT) + l.endWidth * clampedT),
    color: {
      r: Math.round(l.startColor.r + (l.endColor.r - l.startColor.r) * clampedT),
      g: Math.round(l.startColor.g + (l.endColor.g - l.startColor.g) * clampedT),
      b: Math.round(l.startColor.b + (l.endColor.b - l.startColor.b) * clampedT),
      a: Math.max(0, Math.min(1, l.startColor.a + (l.endColor.a - l.startColor.a) * clampedT)),
    },
  }));

  // 4. Interpolate Paths
  let paths: SwfShapePath[] = [];
  if (morph.morphEdges && morph.morphEdges.length > 0) {
    paths = buildPathsFromMorphEdges(morph.morphEdges, clampedT);
  } else if (clampedT <= 0 && morph.startPaths && morph.startPaths.length > 0) {
    paths = morph.startPaths;
  } else if (clampedT >= 1 && morph.endPaths && morph.endPaths.length > 0) {
    paths = morph.endPaths;
  } else {
    paths = morph.startPaths || [];
  }

  return {
    id: morph.id,
    bounds,
    fillStyles,
    lineStyles,
    paths,
  };
}
