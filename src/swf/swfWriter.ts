/**
 * Authentic SWF Binary Generator
 * Produces byte-for-byte compliant Macromedia/Adobe SWF binary files
 */

import { zlibSync } from 'fflate';

function clamp(val: number, min = 0, max = 255): number {
  return val < min ? min : val > max ? max : val;
}

class BitWriter {
  private buffer: number[] = [];
  private currentByte = 0;
  private bitPos = 0; // 0 to 7

  public writeUB(val: number, nbits: number): void {
    for (let i = nbits - 1; i >= 0; i--) {
      const bit = (val >> i) & 1;
      this.currentByte = (this.currentByte << 1) | bit;
      this.bitPos++;
      if (this.bitPos === 8) {
        this.buffer.push(this.currentByte);
        this.currentByte = 0;
        this.bitPos = 0;
      }
    }
  }

  public writeSB(val: number, nbits: number): void {
    let unsignedVal = val;
    if (val < 0) {
      unsignedVal = (1 << nbits) + val;
    }
    this.writeUB(unsignedVal, nbits);
  }

  public writeFB(val: number, nbits: number): void {
    const fixed = Math.round(val * 65536);
    this.writeSB(fixed, nbits);
  }

  public alignByte(): void {
    if (this.bitPos > 0) {
      this.currentByte = this.currentByte << (8 - this.bitPos);
      this.buffer.push(this.currentByte);
      this.currentByte = 0;
      this.bitPos = 0;
    }
  }

  public writeUI8(val: number): void {
    this.alignByte();
    this.buffer.push(val & 0xff);
  }

  public writeUI16(val: number): void {
    this.alignByte();
    this.buffer.push(val & 0xff);
    this.buffer.push((val >> 8) & 0xff);
  }

  public writeUI32(val: number): void {
    this.alignByte();
    this.buffer.push(val & 0xff);
    this.buffer.push((val >> 8) & 0xff);
    this.buffer.push((val >> 16) & 0xff);
    this.buffer.push((val >> 24) & 0xff);
  }

  public writeBytes(bytes: Uint8Array | number[]): void {
    this.alignByte();
    for (const b of bytes) {
      this.buffer.push(b & 0xff);
    }
  }

  public writeRect(xmin: number, xmax: number, ymin: number, ymax: number): void {
    this.alignByte();
    // compute required bits
    const maxVal = Math.max(Math.abs(xmin), Math.abs(xmax), Math.abs(ymin), Math.abs(ymax));
    let nbits = 1;
    while ((1 << (nbits - 1)) <= maxVal && nbits < 31) {
      nbits++;
    }
    nbits = Math.max(nbits + 1, 5); // include sign bit

    this.writeUB(nbits, 5);
    this.writeSB(xmin, nbits);
    this.writeSB(xmax, nbits);
    this.writeSB(ymin, nbits);
    this.writeSB(ymax, nbits);
    this.alignByte();
  }

  public writeMatrix(
    scaleX = 1,
    scaleY = 1,
    transXTwips = 0,
    transYTwips = 0,
    rot0 = 0,
    rot1 = 0
  ): void {
    this.alignByte();
    const hasScale = scaleX !== 1 || scaleY !== 1;
    this.writeUB(hasScale ? 1 : 0, 1);
    if (hasScale) {
      const nScaleBits = 16;
      this.writeUB(nScaleBits, 5);
      this.writeFB(scaleX, nScaleBits);
      this.writeFB(scaleY, nScaleBits);
    }

    const hasRotate = rot0 !== 0 || rot1 !== 0;
    this.writeUB(hasRotate ? 1 : 0, 1);
    if (hasRotate) {
      const nRotBits = 16;
      this.writeUB(nRotBits, 5);
      this.writeFB(rot0, nRotBits);
      this.writeFB(rot1, nRotBits);
    }

    const maxTrans = Math.max(Math.abs(transXTwips), Math.abs(transYTwips));
    let nTransBits = 1;
    while ((1 << (nTransBits - 1)) <= maxTrans && nTransBits < 31) {
      nTransBits++;
    }
    nTransBits = Math.max(nTransBits + 1, 5);

    this.writeUB(nTransBits, 5);
    this.writeSB(transXTwips, nTransBits);
    this.writeSB(transYTwips, nTransBits);
    this.alignByte();
  }

  public toUint8Array(): Uint8Array {
    this.alignByte();
    return new Uint8Array(this.buffer);
  }
}

export function buildSampleSwf(type: 'star' | 'circle' | 'interactive' | 'video' | 'spark' | 'avi' | 'mask'): Uint8Array {
  if (type === 'avi') {
    return buildSampleAvi();
  }

  const widthPx = 550;
  const heightPx = 400;
  const fps = 24;
  const frameCount = type === 'interactive' ? 30 : type === 'video' || type === 'spark' ? 36 : 60;

  // We write the tag stream first to measure total length
  const tagWriter = new BitWriter();

  // 1. Tag 9: SetBackgroundColor
  const bgR = type === 'star' ? 15 : type === 'circle' ? 24 : type === 'video' || type === 'spark' ? 10 : type === 'mask' ? 11 : 30;
  const bgG = type === 'star' ? 23 : type === 'circle' ? 24 : type === 'video' || type === 'spark' ? 15 : type === 'mask' ? 15 : 41;
  const bgB = type === 'star' ? 42 : type === 'circle' ? 37 : type === 'video' || type === 'spark' ? 26 : type === 'mask' ? 26 : 59;
  writeTag(tagWriter, 9, [bgR, bgG, bgB]);

  // 2. Define Shapes / Videos
  if (type === 'video' || type === 'spark') {
    // DefineVideoStream (Tag 60): CharacterID 100, 36 frames, 320x240, Codec 3 (ScreenVideo)
    const streamW = 320;
    const streamH = 240;
    const blockW = 160; // (160 / 16 - 1) = 9
    const blockH = 120; // (120 / 16 - 1) = 7
    const headerByte = (9 << 4) | 7; // 0x97
    const numBlocksX = Math.ceil(streamW / blockW);
    const numBlocksY = Math.ceil(streamH / blockH);

    const vidW = new BitWriter();
    vidW.writeUI16(100); // CharacterID
    vidW.writeUI16(36);  // NumFrames
    vidW.writeUI16(streamW); // Width
    vidW.writeUI16(streamH); // Height
    vidW.writeUI8(1);    // VideoFlags: Smoothing=1
    vidW.writeUI8(3);    // CodecID=3 (Screen Video)
    writeTag(tagWriter, 60, Array.from(vidW.toUint8Array()));

    for (let f = 0; f < frameCount; f++) {
      // Place video character 100 centered
      const place = createPlaceObject2(1, f === 0 ? 100 : 0, {
        scaleX: 1.0,
        scaleY: 1.0,
        transXTwips: Math.round(((widthPx - streamW) / 2) * 20),
        transYTwips: Math.round(((heightPx - streamH) / 2) * 20),
      });
      writeTag(tagWriter, 26, place);

      // Generate high-definition, crystal-clear ScreenVideo frame
      const t = (f / frameCount) * Math.PI * 2;
      const vFrameW = new BitWriter();
      vFrameW.writeUI16(100); // StreamID
      vFrameW.writeUI16(f);   // FrameNum
      vFrameW.writeUI8(headerByte);

      // Render crisp frame onto an offscreen canvas for professional vector typography & graphics
      let frameRgba: Uint8ClampedArray | null = null;
      if (typeof document !== 'undefined') {
        const offCanvas = document.createElement('canvas');
        offCanvas.width = streamW;
        offCanvas.height = streamH;
        const ctx = offCanvas.getContext('2d');
        if (ctx) {
          // 1. Deep studio background
          const bgGrad = ctx.createLinearGradient(0, 0, streamW, streamH);
          bgGrad.addColorStop(0, '#0f172a');
          bgGrad.addColorStop(0.5, '#1e1b4b');
          bgGrad.addColorStop(1, '#020617');
          ctx.fillStyle = bgGrad;
          ctx.fillRect(0, 0, streamW, streamH);

          // 2. Cyan grid
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.15)';
          ctx.lineWidth = 1;
          for (let gx = 0; gx < streamW; gx += 20) {
            ctx.beginPath();
            ctx.moveTo(gx, 0);
            ctx.lineTo(gx, streamH);
            ctx.stroke();
          }
          for (let gy = 0; gy < streamH; gy += 20) {
            ctx.beginPath();
            ctx.moveTo(0, gy);
            ctx.lineTo(streamW, gy);
            ctx.stroke();
          }

          // 3. Orbiting glowing cyber sphere
          const orbX = streamW / 2 + Math.cos(t) * 90;
          const orbY = streamH / 2 + Math.sin(t * 2) * 45;
          const orbGrad = ctx.createRadialGradient(orbX - 6, orbY - 6, 2, orbX, orbY, 28);
          orbGrad.addColorStop(0, '#ffffff');
          orbGrad.addColorStop(0.3, '#38bdf8');
          orbGrad.addColorStop(0.8, '#0284c7');
          orbGrad.addColorStop(1, 'rgba(2, 132, 199, 0)');
          ctx.fillStyle = orbGrad;
          ctx.beginPath();
          ctx.arc(orbX, orbY, 28, 0, Math.PI * 2);
          ctx.fill();

          // 4. Center Gold Diamond Target
          ctx.save();
          ctx.translate(streamW / 2, streamH / 2);
          ctx.rotate(t);
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 2;
          ctx.strokeRect(-24, -24, 48, 48);
          ctx.rotate(Math.PI / 4);
          ctx.strokeStyle = '#38bdf8';
          ctx.strokeRect(-18, -18, 36, 36);
          ctx.restore();

          // 5. Audio visualizer equalizer bars at bottom
          const numBars = 16;
          const barWidth = 12;
          const startBarX = (streamW - (numBars * 16)) / 2;
          for (let b = 0; b < numBars; b++) {
            const barH = 10 + Math.abs(Math.sin(t * 3 + b * 0.5)) * 36;
            const barX = startBarX + b * 16;
            const barY = streamH - 24 - barH;
            const barGrad = ctx.createLinearGradient(0, barY, 0, barY + barH);
            barGrad.addColorStop(0, '#f43f5e');
            barGrad.addColorStop(0.4, '#fbbf24');
            barGrad.addColorStop(1, '#10b981');
            ctx.fillStyle = barGrad;
            ctx.fillRect(barX, barY, barWidth, barH);
          }

          // 6. Header Badge & Typography
          ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
          ctx.lineWidth = 1;
          ctx.fillRect(12, 12, streamW - 24, 32);
          ctx.strokeRect(12, 12, streamW - 24, 32);

          ctx.fillStyle = '#38bdf8';
          ctx.font = 'bold 11px system-ui, sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText(type === 'spark' ? 'SORENSON SPARK VIDEO' : 'FLASH VIDEO STREAM', 22, 32);

          ctx.fillStyle = '#f59e0b';
          ctx.font = 'bold 10px monospace';
          ctx.textAlign = 'right';
          ctx.fillText(`FRAME ${String(f + 1).padStart(2, '0')}/36`, streamW - 22, 32);

          frameRgba = ctx.getImageData(0, 0, streamW, streamH).data;
        }
      }

      for (let by = 0; by < numBlocksY; by++) {
        for (let bx = 0; bx < numBlocksX; bx++) {
          const curW = Math.min(blockW, streamW - bx * blockW);
          const curH = Math.min(blockH, streamH - by * blockH);
          const startX = bx * blockW;
          const startY = by * blockH;

          // ScreenVideo uncompressed format is 24-bit BGR stored bottom-up per block
          const blockBgr = new Uint8Array(curW * curH * 3);
          let ptr = 0;

          for (let row = curH - 1; row >= 0; row--) {
            const py = startY + row;
            for (let col = 0; col < curW; col++) {
              const px = startX + col;

              if (frameRgba) {
                const srcIdx = (py * streamW + px) * 4;
                blockBgr[ptr] = frameRgba[srcIdx + 2];     // B
                blockBgr[ptr + 1] = frameRgba[srcIdx + 1]; // G
                blockBgr[ptr + 2] = frameRgba[srcIdx];     // R
              } else {
                const dx = px - streamW / 2;
                const dy = py - streamH / 2;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const ring = Math.sin(dist * 0.1 - t * 2) * 127 + 128;
                blockBgr[ptr] = Math.round(ring * 0.9);     // B
                blockBgr[ptr + 1] = Math.round(ring * 0.7); // G
                blockBgr[ptr + 2] = Math.round(ring * 0.3); // R
              }
              ptr += 3;
            }
          }

          const compressed = zlibSync(blockBgr);
          vFrameW.writeUI16(compressed.length);
          vFrameW.writeBytes(compressed);
        }
      }

      writeTag(tagWriter, 61, Array.from(vFrameW.toUint8Array()));
      writeTag(tagWriter, 1, []);
    }
  } else if (type === 'star') {
    // Define a 5-point glowing star shape (ID 1)
    const shapeBytes = createStarShape(1, 2000, 2000); // 100x100 px in twips
    writeTag(tagWriter, 32, shapeBytes); // DefineShape3 (RGBA)

    // Define a smaller orb shape (ID 2)
    const orbBytes = createCircleShape(2, 600, { r: 56, g: 189, b: 248, a: 230 });
    writeTag(tagWriter, 32, orbBytes);

    // Place and animate across 60 frames
    for (let f = 0; f < frameCount; f++) {
      const t = (f / frameCount) * Math.PI * 2;
      // Orbit star in center
      const centerX = widthPx / 2 + Math.sin(t * 2) * 80;
      const centerY = heightPx / 2 + Math.cos(t) * 50;
      const starScale = 1.0 + Math.sin(t * 3) * 0.3;

      // PlaceObject2 for star at depth 1
      const starPlace = createPlaceObject2(1, f === 0 ? 1 : 0, {
        scaleX: starScale,
        scaleY: starScale,
        transXTwips: Math.round(centerX * 20),
        transYTwips: Math.round(centerY * 20),
        rot0: Math.sin(t) * 0.3,
        rot1: -Math.sin(t) * 0.3,
      });
      writeTag(tagWriter, 26, starPlace);

      // PlaceObject2 for orbiting orb at depth 2
      const orbX = centerX + Math.cos(t * 4) * 120;
      const orbY = centerY + Math.sin(t * 4) * 60;
      const orbPlace = createPlaceObject2(2, f === 0 ? 2 : 0, {
        scaleX: 1.2,
        scaleY: 1.2,
        transXTwips: Math.round(orbX * 20),
        transYTwips: Math.round(orbY * 20),
      });
      writeTag(tagWriter, 26, orbPlace);

      // ShowFrame
      writeTag(tagWriter, 1, []);
    }
  } else if (type === 'circle') {
    // Colorful bouncing vector orbs
    const colors = [
      { r: 244, g: 63, b: 94, a: 240 },
      { r: 168, g: 85, b: 247, a: 240 },
      { r: 59, g: 130, b: 246, a: 240 },
      { r: 16, g: 185, b: 129, a: 240 },
    ];

    for (let i = 0; i < 4; i++) {
      const shapeBytes = createCircleShape(i + 1, 800 + i * 200, colors[i]);
      writeTag(tagWriter, 32, shapeBytes);
    }

    for (let f = 0; f < frameCount; f++) {
      for (let i = 0; i < 4; i++) {
        const offset = (i * Math.PI) / 2;
        const t = (f / frameCount) * Math.PI * 2 + offset;
        const x = widthPx / 2 + Math.sin(t * (i + 1)) * (120 + i * 20);
        const y = heightPx / 2 + Math.cos(t * 2) * (70 + i * 15);
        const scale = 0.8 + Math.sin(t * 3) * 0.25;

        const place = createPlaceObject2(i + 1, f === 0 ? i + 1 : 0, {
          scaleX: scale,
          scaleY: scale,
          transXTwips: Math.round(x * 20),
          transYTwips: Math.round(y * 20),
        });
        writeTag(tagWriter, 26, place);
      }
      writeTag(tagWriter, 1, []);
    }
  } else if (type === 'interactive') {
    // Interactive: Has ActionScript stop() and trace()
    const boxBytes = createRoundedRectShape(1, 2400, 1600, { r: 99, g: 102, b: 241, a: 255 });
    writeTag(tagWriter, 32, boxBytes);

    for (let f = 0; f < frameCount; f++) {
      const t = (f / frameCount) * Math.PI * 2;
      const x = widthPx / 2;
      const y = heightPx / 2 + Math.sin(t) * 40;

      const place = createPlaceObject2(1, f === 0 ? 1 : 0, {
        scaleX: 1.0,
        scaleY: 1.0,
        transXTwips: Math.round(x * 20),
        transYTwips: Math.round(y * 20),
        rot0: Math.sin(t) * 0.2,
        rot1: -Math.sin(t) * 0.2,
      });
      writeTag(tagWriter, 26, place);

      if (f === 15) {
        // Tag 12: DoAction trace("Frame 15 reached!")
        const actionBytes = [0x96, 0x14, 0x00, 0x00, ...Array.from(new TextEncoder().encode('Frame 15 reached!\0')), 0x26, 0x00];
        writeTag(tagWriter, 12, actionBytes);
      }

      writeTag(tagWriter, 1, []);
    }
  } else if (type === 'mask') {
    // 1. Define Shape 1: Circular spotlight mask (ID 1)
    const spotlightRadius = 1600; // 80px radius in twips
    const maskBytes = createCircleShape(1, spotlightRadius, { r: 255, g: 255, b: 255, a: 255 });
    writeTag(tagWriter, 32, maskBytes);

    // 2. Define Shape 2: Rich vibrant gradient card (ID 2)
    const contentBytes = createRoundedRectShape(2, 4200, 2800, { r: 244, g: 63, b: 94, a: 255 });
    writeTag(tagWriter, 32, contentBytes);

    // 3. Define Shape 3: Golden 5-point star inside (ID 3)
    const starBytes = createStarShape(3, 2200, 2200);
    writeTag(tagWriter, 32, starBytes);

    // 4. Define Shape 4: Subtle unmasked background guide grid/border (ID 4)
    const frameBorder = createRoundedRectShape(4, 4800, 3400, { r: 30, g: 41, b: 59, a: 160 });
    writeTag(tagWriter, 32, frameBorder);

    // Animate spotlight sweep across 60 frames
    for (let f = 0; f < frameCount; f++) {
      const t = (f / frameCount) * Math.PI * 2;
      const spotX = widthPx / 2 + Math.cos(t) * 140;
      const spotY = heightPx / 2 + Math.sin(t * 2) * 65;
      const spotScale = 1.0 + Math.sin(t * 3) * 0.25;

      // Depth 1: Mask placed with clipDepth = 3! (Masks depths 2 & 3)
      const maskPlace = createPlaceObject2(1, f === 0 ? 1 : 0, {
        scaleX: spotScale,
        scaleY: spotScale,
        transXTwips: Math.round(spotX * 20),
        transYTwips: Math.round(spotY * 20),
        clipDepth: 3,
      });
      writeTag(tagWriter, 26, maskPlace);

      // Depth 2: Clipped Card Graphic (revealed strictly inside the spotlight!)
      const contentPlace = createPlaceObject2(2, f === 0 ? 2 : 0, {
        scaleX: 1.0,
        scaleY: 1.0,
        transXTwips: Math.round((widthPx / 2) * 20),
        transYTwips: Math.round((heightPx / 2) * 20),
      });
      writeTag(tagWriter, 26, contentPlace);

      // Depth 3: Clipped Rotating Golden Star (also revealed strictly inside spotlight!)
      const starPlace = createPlaceObject2(3, f === 0 ? 3 : 0, {
        scaleX: 1.2,
        scaleY: 1.2,
        transXTwips: Math.round((widthPx / 2) * 20),
        transYTwips: Math.round((heightPx / 2) * 20),
        rot0: t,
        rot1: -t,
      });
      writeTag(tagWriter, 26, starPlace);

      // Depth 4: Unmasked Outer Stage Frame (outside the mask)
      const borderPlace = createPlaceObject2(4, f === 0 ? 4 : 0, {
        scaleX: 1.0,
        scaleY: 1.0,
        transXTwips: Math.round((widthPx / 2) * 20),
        transYTwips: Math.round((heightPx / 2) * 20),
      });
      writeTag(tagWriter, 26, borderPlace);

      writeTag(tagWriter, 1, []);
    }
  }

  // Tag 0: End
  writeTag(tagWriter, 0, []);

  const tagData = tagWriter.toUint8Array();

  // Build full SWF file with FWS header
  const headerWriter = new BitWriter();
  // Signature 'FWS'
  headerWriter.writeUI8(0x46); // 'F'
  headerWriter.writeUI8(0x57); // 'W'
  headerWriter.writeUI8(0x53); // 'S'
  headerWriter.writeUI8(8); // Flash version 8

  const totalLength = 8 + 17 + tagData.length; // 8 bytes header + rect/fps/count + tags
  headerWriter.writeUI32(totalLength);

  // Frame size: 0, 550*20 twips, 0, 400*20 twips
  headerWriter.writeRect(0, widthPx * 20, 0, heightPx * 20);
  // Frame rate: 24.0 fps (fixed 8.8)
  headerWriter.writeUI8(0);
  headerWriter.writeUI8(fps);
  // Frame count
  headerWriter.writeUI16(frameCount);

  const headerBytes = headerWriter.toUint8Array();

  const finalSwf = new Uint8Array(headerBytes.length + tagData.length);
  finalSwf.set(headerBytes, 0);
  finalSwf.set(tagData, headerBytes.length);

  // Fix up file length UI32 at offset 4
  finalSwf[4] = finalSwf.length & 0xff;
  finalSwf[5] = (finalSwf.length >> 8) & 0xff;
  finalSwf[6] = (finalSwf.length >> 16) & 0xff;
  finalSwf[7] = (finalSwf.length >> 24) & 0xff;

  return finalSwf;
}

function writeTag(writer: BitWriter, tagCode: number, data: number[] | Uint8Array): void {
  const len = data.length;
  if (len < 63) {
    const codeAndLen = (tagCode << 6) | len;
    writer.writeUI16(codeAndLen);
  } else {
    const codeAndLen = (tagCode << 6) | 0x3f;
    writer.writeUI16(codeAndLen);
    writer.writeUI32(len);
  }
  writer.writeBytes(data);
}

function createStarShape(shapeId: number, halfW: number, halfH: number): number[] {
  const w = new BitWriter();
  w.writeUI16(shapeId);
  w.writeRect(-halfW, halfW, -halfH, halfH); // bounds

  // FillStyleArray (1 solid fill: gold yellow)
  w.writeUI8(1); // 1 fill style
  w.writeUI8(0x00); // solid fill
  // RGBA
  w.writeUI8(250); // R
  w.writeUI8(204); // G
  w.writeUI8(21); // B
  w.writeUI8(255); // A

  // LineStyleArray (1 line style: amber outline)
  w.writeUI8(1);
  w.writeUI16(40); // 2px width
  w.writeUI8(217); // R
  w.writeUI8(119); // G
  w.writeUI8(6); // B
  w.writeUI8(255); // A

  // NumFillBits (1), NumLineBits (1)
  w.writeUB(1, 4);
  w.writeUB(1, 4);

  // Shape records: 5-point star
  // 1. StyleChangeRecord (MoveTo top point, FillStyle0=1, LineStyle=1)
  w.writeUB(0, 1); // type 0
  w.writeUB(0, 1); // new styles: false
  w.writeUB(1, 1); // lineStyle: true
  w.writeUB(0, 1); // fillStyle1: false
  w.writeUB(1, 1); // fillStyle0: true
  w.writeUB(1, 1); // moveTo: true

  // MoveTo: 0, -halfH
  const moveBits = 14;
  w.writeUB(moveBits, 5);
  w.writeSB(0, moveBits);
  w.writeSB(-halfH, moveBits);

  w.writeUB(1, 1); // fillStyle0 = 1
  w.writeUB(1, 1); // lineStyle = 1

  // Draw 10 points (outer and inner star points)
  const points = 5;
  const rOuter = halfH;
  const rInner = halfH * 0.45;

  let lastX = 0;
  let lastY = -rOuter;

  for (let i = 1; i <= points * 2; i++) {
    const angle = (i * Math.PI) / points - Math.PI / 2;
    const r = i % 2 === 0 ? rOuter : rInner;
    const px = Math.round(Math.cos(angle) * r);
    const py = Math.round(Math.sin(angle) * r);

    const dx = px - lastX;
    const dy = py - lastY;
    lastX = px;
    lastY = py;

    // StraightEdgeRecord
    w.writeUB(1, 1); // type 1
    w.writeUB(1, 1); // straight line
    const edgeBits = 13;
    w.writeUB(edgeBits - 2, 4);
    w.writeUB(1, 1); // general line
    w.writeSB(dx, edgeBits);
    w.writeSB(dy, edgeBits);
  }

  // EndShapeRecord
  w.writeUB(0, 6);
  w.alignByte();

  return Array.from(w.toUint8Array());
}

function createCircleShape(
  shapeId: number,
  radiusTwips: number,
  color: { r: number; g: number; b: number; a: number }
): number[] {
  const w = new BitWriter();
  w.writeUI16(shapeId);
  w.writeRect(-radiusTwips, radiusTwips, -radiusTwips, radiusTwips);

  // FillStyleArray (1 solid fill)
  w.writeUI8(1);
  w.writeUI8(0x00);
  w.writeUI8(color.r);
  w.writeUI8(color.g);
  w.writeUI8(color.b);
  w.writeUI8(color.a);

  // LineStyleArray (1 line style)
  w.writeUI8(1);
  w.writeUI16(30);
  w.writeUI8(255);
  w.writeUI8(255);
  w.writeUI8(255);
  w.writeUI8(200);

  w.writeUB(1, 4);
  w.writeUB(1, 4);

  // MoveTo (0, -radiusTwips)
  w.writeUB(0, 1);
  w.writeUB(0, 1);
  w.writeUB(1, 1);
  w.writeUB(0, 1);
  w.writeUB(1, 1);
  w.writeUB(1, 1);

  const moveBits = 14;
  w.writeUB(moveBits, 5);
  w.writeSB(0, moveBits);
  w.writeSB(-radiusTwips, moveBits);
  w.writeUB(1, 1); // fillStyle0
  w.writeUB(1, 1); // lineStyle

  // Draw circle using 4 quadratic beziers
  // Control point distance for circle approximation: r * (sqrt(2) - 1) * 2 approx 0.8284 or 1.0
  const c = Math.round(radiusTwips);
  const segments = [
    { cx: c, cy: -radiusTwips, ax: radiusTwips, ay: 0 },
    { cx: radiusTwips, cy: c, ax: 0, ay: radiusTwips },
    { cx: -c, cy: radiusTwips, ax: -radiusTwips, ay: 0 },
    { cx: -radiusTwips, cy: -c, ax: 0, ay: -radiusTwips },
  ];

  let curX = 0;
  let curY = -radiusTwips;

  for (const seg of segments) {
    const cdx = seg.cx - curX;
    const cdy = seg.cy - curY;
    const adx = seg.ax - seg.cx;
    const ady = seg.ay - seg.cy;

    curX = seg.ax;
    curY = seg.ay;

    w.writeUB(1, 1); // type 1
    w.writeUB(0, 1); // curve
    const bits = 14;
    w.writeUB(bits - 2, 4);
    w.writeSB(cdx, bits);
    w.writeSB(cdy, bits);
    w.writeSB(adx, bits);
    w.writeSB(ady, bits);
  }

  // EndShape
  w.writeUB(0, 6);
  w.alignByte();

  return Array.from(w.toUint8Array());
}

function createRoundedRectShape(
  shapeId: number,
  halfW: number,
  halfH: number,
  color: { r: number; g: number; b: number; a: number }
): number[] {
  const w = new BitWriter();
  w.writeUI16(shapeId);
  w.writeRect(-halfW, halfW, -halfH, halfH);

  // FillStyle: Solid
  w.writeUI8(1);
  w.writeUI8(0x00);
  w.writeUI8(color.r);
  w.writeUI8(color.g);
  w.writeUI8(color.b);
  w.writeUI8(color.a);

  // LineStyle
  w.writeUI8(1);
  w.writeUI16(40);
  w.writeUI8(255);
  w.writeUI8(255);
  w.writeUI8(255);
  w.writeUI8(180);

  w.writeUB(1, 4);
  w.writeUB(1, 4);

  // MoveTo (-halfW, -halfH)
  w.writeUB(0, 1);
  w.writeUB(0, 1);
  w.writeUB(1, 1);
  w.writeUB(0, 1);
  w.writeUB(1, 1);
  w.writeUB(1, 1);

  const moveBits = 14;
  w.writeUB(moveBits, 5);
  w.writeSB(-halfW, moveBits);
  w.writeSB(-halfH, moveBits);
  w.writeUB(1, 1);
  w.writeUB(1, 1);

  // 4 straight edges
  const edges = [
    { dx: halfW * 2, dy: 0 },
    { dx: 0, dy: halfH * 2 },
    { dx: -halfW * 2, dy: 0 },
    { dx: 0, dy: -halfH * 2 },
  ];

  for (const e of edges) {
    w.writeUB(1, 1);
    w.writeUB(1, 1);
    const bits = 14;
    w.writeUB(bits - 2, 4);
    w.writeUB(1, 1);
    w.writeSB(e.dx, bits);
    w.writeSB(e.dy, bits);
  }

  w.writeUB(0, 6);
  w.alignByte();

  return Array.from(w.toUint8Array());
}

function createPlaceObject2(
  depth: number,
  characterId: number,
  opts: {
    scaleX?: number;
    scaleY?: number;
    transXTwips?: number;
    transYTwips?: number;
    rot0?: number;
    rot1?: number;
    clipDepth?: number;
  }
): number[] {
  const w = new BitWriter();
  const hasChar = characterId > 0;
  const hasMatrix = true;
  const hasClipDepth = opts.clipDepth !== undefined && opts.clipDepth > depth;

  // PlaceFlags: hasChar (0x02), hasMatrix (0x04), hasClipDepth (0x40)
  let flags = 0;
  if (hasChar) flags |= 0x02;
  if (hasMatrix) flags |= 0x04;
  if (hasClipDepth) flags |= 0x40;

  w.writeUI8(flags);
  w.writeUI16(depth);

  if (hasChar) {
    w.writeUI16(characterId);
  }

  w.writeMatrix(
    opts.scaleX ?? 1,
    opts.scaleY ?? 1,
    opts.transXTwips ?? 0,
    opts.transYTwips ?? 0,
    opts.rot0 ?? 0,
    opts.rot1 ?? 0
  );

  if (hasClipDepth) {
    w.writeUI16(opts.clipDepth!);
  }

  return Array.from(w.toUint8Array());
}

/**
 * Builds a authentic binary RIFF AVI video file with 24 frames of DIB BGR24 motion graphics
 */
export function buildSampleAvi(): Uint8Array {
  const width = 320;
  const height = 240;
  const fps = 15;
  const numFrames = 30;
  const rowStride = Math.floor((width * 3 + 3) / 4) * 4;
  const frameSize = rowStride * height;

  const w = new BitWriter();

  // Helper for 4CC
  const writeStr = (s: string) => {
    for (let i = 0; i < s.length; i++) w.writeUI8(s.charCodeAt(i));
  };

  // Pre-generate frames
  const frameBuffers: Uint8Array[] = [];
  for (let f = 0; f < numFrames; f++) {
    const t = (f / numFrames) * Math.PI * 2;
    const buf = new Uint8Array(frameSize);

    for (let y = 0; y < height; y++) {
      const srcY = height - 1 - y; // Bottom-up
      const rowOffset = srcY * rowStride;
      for (let x = 0; x < width; x++) {
        const dx = x - width / 2;
        const dy = y - height / 2;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Retro arcade plasma pattern
        const plasma = Math.sin(dist * 0.08 - t * 3) * 60 + Math.sin(x * 0.05 + t) * 40 + 128;
        const grid = (x % 20 === 0 || y % 20 === 0) ? 40 : 0;

        const r = clamp(plasma + grid + Math.sin(t) * 30);
        const g = clamp(plasma * 0.7 + grid + Math.cos(t) * 40);
        const b = clamp(255 - plasma * 0.5 + grid);

        const px = rowOffset + x * 3;
        buf[px] = b;     // B
        buf[px + 1] = g; // G
        buf[px + 2] = r; // R
      }
    }
    frameBuffers.push(buf);
  }

  // Calculate sizes
  const moviSize = 4 + numFrames * (8 + frameSize);
  const strfSize = 40;
  const strhSize = 56;
  const strlSize = 4 + (8 + strhSize) + (8 + strfSize);
  const avihSize = 56;
  const hdrlSize = 4 + (8 + avihSize) + (8 + strlSize);
  const riffSize = 4 + (8 + hdrlSize) + (8 + moviSize);

  // 'RIFF'
  writeStr('RIFF');
  w.writeUI32(riffSize);
  writeStr('AVI ');

  // 'LIST' hdrl
  writeStr('LIST');
  w.writeUI32(hdrlSize);
  writeStr('hdrl');

  // 'avih'
  writeStr('avih');
  w.writeUI32(avihSize);
  w.writeUI32(Math.round(1000000 / fps)); // dwMicroSecPerFrame
  w.writeUI32(0); // dwMaxBytesPerSec
  w.writeUI32(0); // dwPaddingGranularity
  w.writeUI32(0x10); // dwFlags (AVIF_HASINDEX)
  w.writeUI32(numFrames); // dwTotalFrames
  w.writeUI32(0); // dwInitialFrames
  w.writeUI32(1); // dwStreams
  w.writeUI32(frameSize); // dwSuggestedBufferSize
  w.writeUI32(width); // dwWidth
  w.writeUI32(height); // dwHeight
  w.writeUI32(0); w.writeUI32(0); w.writeUI32(0); w.writeUI32(0); // reserved

  // 'LIST' strl
  writeStr('LIST');
  w.writeUI32(strlSize);
  writeStr('strl');

  // 'strh'
  writeStr('strh');
  w.writeUI32(strhSize);
  writeStr('vids'); // fccType
  writeStr('DIB '); // fccHandler
  w.writeUI32(0); // dwFlags
  w.writeUI16(0); // wPriority
  w.writeUI16(0); // wLanguage
  w.writeUI32(0); // dwInitialFrames
  w.writeUI32(1); // dwScale
  w.writeUI32(fps); // dwRate
  w.writeUI32(0); // dwStart
  w.writeUI32(numFrames); // dwLength
  w.writeUI32(frameSize); // dwSuggestedBufferSize
  w.writeUI32(0); // dwQuality
  w.writeUI32(0); // dwSampleSize
  w.writeUI16(0); w.writeUI16(0); w.writeUI16(width); w.writeUI16(height); // rcFrame

  // 'strf' (BITMAPINFOHEADER)
  writeStr('strf');
  w.writeUI32(strfSize);
  w.writeUI32(40); // biSize
  w.writeUI32(width); // biWidth
  w.writeUI32(height); // biHeight
  w.writeUI16(1); // biPlanes
  w.writeUI16(24); // biBitCount (24bpp BGR)
  w.writeUI32(0); // biCompression (BI_RGB / DIB)
  w.writeUI32(frameSize); // biSizeImage
  w.writeUI32(0); // biXPelsPerMeter
  w.writeUI32(0); // biYPelsPerMeter
  w.writeUI32(0); // biClrUsed
  w.writeUI32(0); // biClrImportant

  // 'LIST' movi
  writeStr('LIST');
  w.writeUI32(moviSize);
  writeStr('movi');

  // Write video frames
  for (let f = 0; f < numFrames; f++) {
    writeStr('00db'); // uncompressed video chunk
    w.writeUI32(frameSize);
    w.writeBytes(frameBuffers[f]);
  }

  return w.toUint8Array();
}

