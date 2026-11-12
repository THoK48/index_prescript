const hangulSyllableStart = 0xac00;
const hangulSyllableEnd = 0xd7a3;
const digitWithFinalConsonant = new Set(["0", "1", "3", "6", "7", "8"]);

/** Appends 을/를 from the last pronounceable Korean syllable or digit without exposing a placeholder. */
export function appendObjectParticle(value: string): string {
  const title = value.trim();
  if (!title) return title;
  const characters = Array.from(title);

  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index];
    const codePoint = character.codePointAt(0) ?? 0;
    const hasTrailingDecoration = index !== characters.length - 1;
    const decorate = (particle: "을" | "를") => hasTrailingDecoration ? `“${title}”${particle}` : `${title}${particle}`;

    if (codePoint >= hangulSyllableStart && codePoint <= hangulSyllableEnd) {
      return decorate((codePoint - hangulSyllableStart) % 28 === 0 ? "를" : "을");
    }
    if (/\d/.test(character)) return decorate(digitWithFinalConsonant.has(character) ? "을" : "를");
    if (/[a-z]/i.test(character)) return `“${title}” 항목을`;
  }

  return `“${title}” 항목을`;
}
