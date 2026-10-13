const decryptionGlyphs = "01#*+<>[]{}▓▒░";
const preservedCharacterPattern = /[\s.,!?…:;()'"/\-]/u;

/** Builds one deterministic-friendly frame for the progressive text decryption effect. */
export function createDecryptionFrame(
  text: string,
  revealedCharacters: number,
  randomValue: () => number = Math.random,
): string {
  return Array.from(text, (character, index) => {
    if (index < revealedCharacters || preservedCharacterPattern.test(character)) return character;
    const glyphIndex = Math.floor(randomValue() * decryptionGlyphs.length) % decryptionGlyphs.length;
    return decryptionGlyphs[glyphIndex];
  }).join("");
}
