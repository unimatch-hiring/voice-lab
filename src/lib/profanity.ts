// Whole words from their start, never substrings: "хлеб", "гребля" and "Scunthorpe"
// all contain something on this list.
const WORDS = [
  "бля(?:д\\p{L}*|т[ьи]?)?",
  "(?:на|по|о|ни|не|за|до|от|при|вы|у|а)?ху[йеёяи]\\p{L}*",
  "хули",
  "(?:рас|рос|с|от|на|вы|за|пере|до|по|у|о)?пизд\\p{L}*",
  "(?:на|за|вы|у|до|от|по|съ|разъ|подъ|отъ|объ|въ)?[её]б(?:[аеёилнуыюя]\\p{L}*)?",
  "у[её]бо\\p{L}*",
  "долбо[её]б\\p{L}*",
  "муд(?:ак|ил|озв)\\p{L}*",
  "сук(?:а|и|е|у|ой|ам|ами|ах)",
  "сучар\\p{L}*",
  "гандон\\p{L}*",
  "п[ие]д[ао]р\\p{L}*",
  "педик(?:а|у|ом|е|и|ов|ам|ами|ах)?",
  "шлюх\\p{L}*",
  "залуп\\p{L}*",
  "манд(?:а|ы|е|у|ой)",
  "ублюд\\p{L}*",
  "дерьм\\p{L}*",
  "говн\\p{L}*",
  "жоп\\p{L}*",
  "(?:mother)?fuck\\p{L}*",
  "(?:bull)?shit(?:s|ty|head\\p{L}*)?",
  "bitch\\p{L}*",
  "asshole\\p{L}*",
  "cunts?",
  "dickhead\\p{L}*",
  "bastards?",
  "sluts?",
  "whores?",
  "nigger\\p{L}*",
  "faggot\\p{L}*",
];

const PROFANITY = new RegExp(`(?<![\\p{L}\\p{N}])(?:${WORDS.join("|")})(?![\\p{L}\\p{N}])`, "giu");

export function maskProfanity(text: string): string {
  return text.replace(PROFANITY, (word) => "*".repeat(word.length));
}
