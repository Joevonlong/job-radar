export interface LanguageLexicon {
  keywords: Record<string, string[]>;
  filler: string[];
  weak: string[];
  proseWords: string[];
  asksSalary: string[];
  asksStart: string[];
  stockOpener: string[];
  level: string[];
  titleStop: string[];
  legal: string[];
  letterLegal: string[];
  roleWord: string[];
  nice: string[];
  requiredHead: string[];
  skipHead: string[];
  tasksHead: string[];
  skipSentence: string[];
  notTech: string[];
  degree: { words: string[]; suffixes: string[] };
  langContext: string[];
  langs: Record<string, string[]>;
  names: Record<string, string[]>;
  levelWords: { native: string[]; ranked: { rank: number; words: string[] }[] };
}

export interface CheckLexicon {
  en: LanguageLexicon;
  de: LanguageLexicon;
}
