/**
 * SWF Binary & Bit Stream Reader
 */

import { SwfColorRGBA, SwfColorTransform, SwfMatrix, SwfRect } from './types';
import { decodeSwfString } from './stringUtils';

export class BitReader {
  public bytes: Uint8Array;
  public pos: number; // byte position
  public bitPos: number; // 0 to 7 (0 is MSB)

  constructor(bytes: Uint8Array, startPos = 0) {
    this.bytes = bytes;
    this.pos = startPos;
    this.bitPos = 0;
  }

  get eof(): boolean {
    return this.pos >= this.bytes.length;
  }

  get remaining(): number {
    return Math.max(0, this.bytes.length - this.pos);
  }

  public alignByte(): void {
    if (this.bitPos > 0) {
      this.bitPos = 0;
      this.pos++;
    }
  }

  public readUB(nbits: number): number {
    if (nbits === 0) return 0;
    let result = 0;
    for (let i = 0; i < nbits; i++) {
      if (this.pos >= this.bytes.length) {
        return result;
      }
      const byte = this.bytes[this.pos];
      const bit = (byte >> (7 - this.bitPos)) & 1;
      result = (result << 1) | bit;
      this.bitPos++;
      if (this.bitPos === 8) {
        this.bitPos = 0;
        this.pos++;
      }
    }
    return result;
  }

  public readSB(nbits: number): number {
    if (nbits === 0) return 0;
    const unsignedVal = this.readUB(nbits);
    const signBit = 1 << (nbits - 1);
    if (unsignedVal & signBit) {
      return unsignedVal - (1 << nbits);
    }
    return unsignedVal;
  }

  public readFB(nbits: number): number {
    if (nbits === 0) return 0;
    const val = this.readSB(nbits);
    return val / 65536.0; // 16.16 fixed point
  }

  public readUI8(): number {
    this.alignByte();
    if (this.pos >= this.bytes.length) return 0;
    return this.bytes[this.pos++];
  }

  public readSI8(): number {
    const val = this.readUI8();
    return val > 127 ? val - 256 : val;
  }

  public readUI16(): number {
    this.alignByte();
    if (this.pos + 1 >= this.bytes.length) {
      const b0 = this.readUI8();
      return b0;
    }
    const b0 = this.bytes[this.pos++];
    const b1 = this.bytes[this.pos++];
    return b0 | (b1 << 8);
  }

  public readSI16(): number {
    const val = this.readUI16();
    return val > 32767 ? val - 65536 : val;
  }

  public readUI32(): number {
    this.alignByte();
    if (this.pos + 3 >= this.bytes.length) {
      let val = 0;
      for (let i = 0; i < 4 && this.pos < this.bytes.length; i++) {
        val |= this.bytes[this.pos++] << (i * 8);
      }
      return val >>> 0;
    }
    const b0 = this.bytes[this.pos++];
    const b1 = this.bytes[this.pos++];
    const b2 = this.bytes[this.pos++];
    const b3 = this.bytes[this.pos++];
    return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
  }

  public readFIXED8(): number {
    const frac = this.readUI8();
    const intPart = this.readUI8();
    return intPart + frac / 256.0;
  }

  public readBytes(count: number): Uint8Array {
    this.alignByte();
    const clamped = Math.min(count, this.remaining);
    const sub = this.bytes.slice(this.pos, this.pos + clamped);
    this.pos += clamped;
    return sub;
  }

  public readString(): string {
    this.alignByte();
    const chars: number[] = [];
    while (this.pos < this.bytes.length) {
      const b = this.bytes[this.pos++];
      if (b === 0) break;
      chars.push(b);
    }
    return decodeSwfString(new Uint8Array(chars));
  }

  public readRGB(): SwfColorRGBA {
    this.alignByte();
    const r = this.readUI8();
    const g = this.readUI8();
    const b = this.readUI8();
    return { r, g, b, a: 1 };
  }

  public readRGBA(): SwfColorRGBA {
    this.alignByte();
    const r = this.readUI8();
    const g = this.readUI8();
    const b = this.readUI8();
    const a = this.readUI8() / 255.0;
    return { r, g, b, a };
  }

  public readRect(): SwfRect {
    this.alignByte();
    const nbits = this.readUB(5);
    const xmin = this.readSB(nbits);
    const xmax = this.readSB(nbits);
    const ymin = this.readSB(nbits);
    const ymax = this.readSB(nbits);
    this.alignByte();

    return {
      nbits,
      xmin,
      xmax,
      ymin,
      ymax,
      width: Math.max(0, (xmax - xmin) / 20),
      height: Math.max(0, (ymax - ymin) / 20),
    };
  }

  public readMatrix(): SwfMatrix {
    this.alignByte();
    const hasScale = this.readUB(1) === 1;
    let scaleX = 1;
    let scaleY = 1;
    if (hasScale) {
      const nScaleBits = this.readUB(5);
      scaleX = this.readFB(nScaleBits);
      scaleY = this.readFB(nScaleBits);
    }

    const hasRotate = this.readUB(1) === 1;
    let rotateSkew0 = 0;
    let rotateSkew1 = 0;
    if (hasRotate) {
      const nRotateBits = this.readUB(5);
      rotateSkew0 = this.readFB(nRotateBits);
      rotateSkew1 = this.readFB(nRotateBits);
    }

    const nTranslateBits = this.readUB(5);
    const transXTwips = this.readSB(nTranslateBits);
    const transYTwips = this.readSB(nTranslateBits);
    this.alignByte();

    return {
      hasScale,
      scaleX,
      scaleY,
      hasRotate,
      rotateSkew0,
      rotateSkew1,
      translateX: transXTwips / 20.0,
      translateY: transYTwips / 20.0,
    };
  }

  public readColorTransform(hasAlpha = false): SwfColorTransform {
    this.alignByte();
    const hasAdd = this.readUB(1) === 1;
    const hasMult = this.readUB(1) === 1;
    const nbits = this.readUB(4);

    let multR = 1, multG = 1, multB = 1, multA = 1;
    let addR = 0, addG = 0, addB = 0, addA = 0;

    if (hasMult) {
      multR = this.readSB(nbits) / 256.0;
      multG = this.readSB(nbits) / 256.0;
      multB = this.readSB(nbits) / 256.0;
      if (hasAlpha) multA = this.readSB(nbits) / 256.0;
    }

    if (hasAdd) {
      addR = this.readSB(nbits);
      addG = this.readSB(nbits);
      addB = this.readSB(nbits);
      if (hasAlpha) addA = this.readSB(nbits);
    }

    this.alignByte();

    return {
      hasAdd,
      hasMult,
      multR,
      multG,
      multB,
      multA,
      addR,
      addG,
      addB,
      addA,
    };
  }
}
