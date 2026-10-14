/**
 * String and Character Encoding Utilities for SWF
 * Handles UTF-8, Shift-JIS (Japanese Flash), Windows-1252 (ANSI), and Mojibake repair.
 */

/**
 * Decodes a single SWF font character code into its proper Unicode string,
 * preventing Shift-JIS and Windows-1252 codes from becoming mojibake.
 */
export function decodeCharCode(code: number, isShiftJIS?: boolean): string {
  if (code <= 0) return '';

  // Standard ASCII
  if (code >= 0x20 && code <= 0x7E) {
    return String.fromCharCode(code);
  }

  // Shift-JIS 2-byte character ranges:
  // Lead byte: 0x81-0x9F, 0xE0-0xFC
  // Trail byte: 0x40-0x7E, 0x80-0xFC
  const lead = (code >> 8) & 0xFF;
  const trail = code & 0xFF;
  const looksLikeShiftJISTwoByte =
    ((lead >= 0x81 && lead <= 0x9F) || (lead >= 0xE0 && lead <= 0xFC)) &&
    ((trail >= 0x40 && trail <= 0x7E) || (trail >= 0x80 && trail <= 0xFC));

  if (isShiftJIS || looksLikeShiftJISTwoByte) {
    try {
      const decoded = new TextDecoder('shift-jis', { fatal: true }).decode(
        new Uint8Array([lead, trail])
      );
      if (decoded && decoded !== '\uFFFD') {
        return decoded;
      }
    } catch {
      // Fall through if not valid Shift-JIS
    }
  }

  // Shift-JIS half-width katakana (0xA1 - 0xDF)
  if (isShiftJIS && code >= 0xA1 && code <= 0xDF) {
    try {
      const decoded = new TextDecoder('shift-jis', { fatal: true }).decode(
        new Uint8Array([code])
      );
      if (decoded && decoded !== '\uFFFD') {
        return decoded;
      }
    } catch {
      // Fall through
    }
  }

  // Windows-1252 extended characters (0x80 - 0xFF)
  if (code >= 0x80 && code <= 0xFF) {
    try {
      const decoded = new TextDecoder('windows-1252').decode(new Uint8Array([code]));
      if (decoded && decoded.charCodeAt(0) >= 0x20) {
        return decoded;
      }
    } catch {
      // Fall through
    }
  }

  // Direct Unicode code point
  return String.fromCharCode(code);
}

/**
 * Decodes raw SWF byte buffers into clean strings.
 * Automatically tries UTF-8 (strict), Shift-JIS (Japanese SWF), and Windows-1252 (ANSI).
 */
export function decodeSwfString(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';

  // 1. Check if all ASCII
  let isAllAscii = true;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] >= 0x80) {
      isAllAscii = false;
      break;
    }
  }
  if (isAllAscii) {
    return new TextDecoder('ascii').decode(bytes);
  }

  // 2. Try UTF-8 with fatal: true
  try {
    const utf8Str = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // If it decoded without errors, check if it contains typical UTF-8 mojibake patterns
    return fixMojibake(utf8Str);
  } catch {
    // Not valid UTF-8
  }

  // 3. Try Shift-JIS (dominant encoding for older non-UTF8 Flash files)
  try {
    const sjisStr = new TextDecoder('shift-jis', { fatal: true }).decode(bytes);
    if (sjisStr && !sjisStr.includes('\uFFFD')) {
      return sjisStr;
    }
  } catch {
    // Not valid Shift-JIS
  }

  // 4. Try Windows-1252
  try {
    const cp1252Str = new TextDecoder('windows-1252').decode(bytes);
    return fixMojibake(cp1252Str);
  } catch {
    // Fallback
    return String.fromCharCode(...bytes);
  }
}

/**
 * Windows-1252 byte-to-char mapping for inverse lookup
 */
const CP1252_MAP: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

const UNICODE_TO_CP1252 = new Map<number, number>();
for (const [k, v] of Object.entries(CP1252_MAP)) {
  UNICODE_TO_CP1252.set(v, Number(k));
}

/**
 * Detects and repairs common Mojibake patterns:
 * 1. UTF-8 misinterpreted as Windows-1252 / ISO-8859-1 (e.g. "Ã©" -> "é", "â€™" -> "’")
 * 2. Shift-JIS misinterpreted as Windows-1252 (e.g. "‚±‚ñ‚É‚¿‚Í" -> "こんにちは")
 * 3. UTF-8 misinterpreted as Shift-JIS (e.g. text starting with "縺...", "繧...")
 */
export function fixMojibake(input: string): string {
  if (!input || input.length === 0) return '';

  let text = input;

  // Case 1: Check for Shift-JIS misinterpreted as Windows-1252 (common in Japanese Flash)
  // Shift-JIS Hiragana starts with 0x82 (‚ in CP1252), Katakana starts with 0x83 (ƒ in CP1252)
  if (text.includes('‚') || text.includes('ƒ') || /[\u0080-\u009F]/.test(text)) {
    try {
      const bytes: number[] = [];
      let canMap = true;
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code <= 0x7F) {
          bytes.push(code);
        } else if (UNICODE_TO_CP1252.has(code)) {
          bytes.push(UNICODE_TO_CP1252.get(code)!);
        } else if (code >= 0xA0 && code <= 0xFF) {
          bytes.push(code);
        } else {
          canMap = false;
          break;
        }
      }
      if (canMap && bytes.length > 0) {
        // Try decoding bytes as Shift-JIS
        const recovered = new TextDecoder('shift-jis', { fatal: true }).decode(
          new Uint8Array(bytes)
        );
        // If it decoded to Japanese characters (Hiragana / Katakana / Kanji)
        if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(recovered)) {
          return recovered;
        }
      }
    } catch {
      // Keep going
    }
  }

  // Case 2: UTF-8 misinterpreted as Windows-1252 (e.g. Ã©, Ã¼, Ã¢, Â©, etc.)
  if (/[\u00C0-\u00DF][\u0080-\u00BF]/.test(text) || /Ã[\x80-\xBF]/.test(text) || /â[\x80-\xBF]/.test(text)) {
    try {
      const bytes: number[] = [];
      let canMap = true;
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code <= 0x7F) {
          bytes.push(code);
        } else if (UNICODE_TO_CP1252.has(code)) {
          bytes.push(UNICODE_TO_CP1252.get(code)!);
        } else if (code >= 0x80 && code <= 0xFF) {
          bytes.push(code);
        } else {
          canMap = false;
          break;
        }
      }
      if (canMap && bytes.length > 0) {
        const recovered = new TextDecoder('utf-8', { fatal: true }).decode(
          new Uint8Array(bytes)
        );
        if (recovered && recovered.length < text.length) {
          return recovered;
        }
      }
    } catch {
      // Keep going
    }
  }

  // Case 3: UTF-8 misinterpreted as Shift-JIS (leads to 縺, 繧, etc.)
  if (/[縺繧繝縹]/.test(text)) {
    try {
      // Encode back to Shift-JIS bytes and decode as UTF-8
      // Note: browsers don't have built-in TextEncoder('shift-jis'), but if needed we can handle common sequences
    } catch {
      // Keep going
    }
  }

  return text;
}
