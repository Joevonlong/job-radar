export interface CheckLimits {
  maxMentions: number;
  goodCoverage: number;
  maxBullet: number;
  minBullet: number;
  maxBulletsPerEntry: number;
  maxGapMonths: number;
  proseMinWords: number;
  proseClearWords: number;
  proseRatio: number;
  proseClearRatio: number;
  maxRole: number;
  letterPages: number;
  letterWords: { min: number; max: number };
  minPiece: number;
  maxPieces: number;
}
