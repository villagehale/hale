// Spelled out rather than read from TextDecoder: Node's 'windows-1252' decoder returns the C1 controls
// for 0x80–0x9F on some builds. C1 stays mapped too, for text that went through a true Latin-1 decode.
const C1_80_9F = Array.from({ length: 32 }, (_, i) => String.fromCharCode(0x80 + i)).join('');
const WINDOWS_1252_80_9F = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
const LATIN_1_A0_FF =
  '\u00a0¡¢£¤¥¦§¨©ª«¬\u00ad®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ';
const ISO_8859_2_A0_FF =
  '\u00a0Ą˘Ł¤ĽŚ§¨ŠŞŤŹ\u00adŽŻ°ą˛ł´ľśˇ¸šşťź˝žżŔÁÂĂÄĹĆÇČÉĘËĚÍÎĎĐŃŇÓÔŐÖ×ŘŮÚŰÜÝŢßŕáâăäĺćçčéęëěíîďđńňóôőö÷řůúűüýţ˙';
const ISO_8859_16_A0_FF =
  '\u00a0ĄąŁ€„Š§š©Ș«Ź\u00adźŻ°±ČłŽ”¶·žčș»ŒœŸżÀÁÂĂÄĆÆÇÈÉÊËÌÍÎÏĐŃÒÓÔŐÖŚŰÙÚÛÜĘȚßàáâăäćæçèéêëìíîïđńòóôőöśűùúûüęțÿ';
const WINDOWS_1257_80_FF =
  '€\u0081‚\u0083„…†‡\u0088‰\u008a‹\u008c¨ˇ¸\u0090‘’“”•–—\u0098™\u009a›\u009c¯˛\u009f\u00a0¡¢£¤¥¦§Ø©Ŗ«¬\u00ad®Æ°±²³´µ¶·ø¹ŗ»¼½¾æĄĮĀĆÄÅĘĒČÉŹĖĢĶĪĻŠŃŅÓŌÕÖ×ŲŁŚŪÜŻŽßąįāćäåęēčéźėģķīļšńņóōõö÷ųłśūüżž˙';

function byteMap(...highHalves: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let byte = 0; byte < 0x80; byte++) map.set(String.fromCharCode(byte), byte);
  for (const high of highHalves) {
    Array.from(high).forEach((char, index) => {
      if (!map.has(char)) map.set(char, 0x80 + index);
    });
  }
  return map;
}

const tables = [
  byteMap(WINDOWS_1252_80_9F + LATIN_1_A0_FF, C1_80_9F + LATIN_1_A0_FF),
  byteMap(C1_80_9F + ISO_8859_2_A0_FF),
  byteMap(C1_80_9F + ISO_8859_16_A0_FF),
  byteMap(WINDOWS_1257_80_FF),
];
const utf8 = new TextDecoder('utf-8', { fatal: true });
const LATIN = /\p{Script=Latin}/u;
const NOT_LATIN_OR_SHARED = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;
// A word-final capital É, Ê or Ë before a no-break space, an ellipsis or curly punctuation, or a word-final
// capital Â or Ā before an ellipsis or curly punctuation, reads back as one of these.
const NEVER_MEANT = /[\u0080-\u009f\u0240-\u02ff]/u;

function isGarbledSegment(bytes: number[]): boolean {
  if (!bytes.some((byte) => byte >= 0x80)) return false;
  let decoded: string;
  try {
    decoded = utf8.decode(Uint8Array.from(bytes));
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
  if (NEVER_MEANT.test(decoded)) return false;
  return !(LATIN.test(decoded) && NOT_LATIN_OR_SHARED.test(decoded));
}

function roundTrips(word: string, table: Map<string, number>): boolean {
  let bytes: number[] = [];
  for (const char of word) {
    const byte = table.get(char);
    if (byte !== undefined) {
      bytes.push(byte);
      continue;
    }
    if (isGarbledSegment(bytes)) return true;
    bytes = [];
  }
  return isGarbledSegment(bytes);
}

export function hasEncodingCorruption(message: string): boolean {
  if (message.includes('\ufffd')) return true;
  const words = message.split(/[\t\n\v\f\r ]+/);
  return tables.some((table) => words.some((word) => roundTrips(word, table)));
}
