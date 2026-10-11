/**
 * Data-visualisation library. Import from here or from the single files; every component is documented
 * in its file. Server components unless the file says "use client" (NumberRoll, motion.tsx).
 */
export { Battery, type BatteryProps } from "./battery";
export { Delta, PairBars, type DeltaProps, type PairBarsProps } from "./delta";
export { Freshness, type FreshnessProps } from "./freshness";
export { Funnel, type FunnelProps, type FunnelStep } from "./funnel";
export { Led, type LedProps, type LedTone } from "./led";
export { CEFR_LEVELS, LevelScale, type CefrLevel, type LevelScaleProps } from "./level-scale";
export { LayoutGroup, PlayOnView, Presence, useReducedMotion, usePlayOnView, VizMotionConfig, motion } from "./motion";
export { NumberRoll, type NumberRollFormat, type NumberRollProps } from "./number-roll";
export { Fraction, PercentBar, PercentText, type FractionProps, type PercentBarProps, type PercentBarSize, type PercentTextProps, type PercentTextSize } from "./percent";
export { Percentile, type PercentileProps } from "./percentile";
export { Ring, type RingProps, type RingSize } from "./ring";
export { SalaryAxis, type SalaryAxisProps } from "./salary-axis";
export { SalaryMini, type SalaryMiniProps } from "./salary-mini";
export { axisTicks, salaryAxisScale, salaryState, type SalaryAxisScale, type SalaryState } from "./salary-shared";
export { ScoreComposition, type ScoreCompositionProps } from "./score-composition";
export { ScoreMeter, type ScoreMeterProps, type ScoreMeterSize } from "./score-meter";
export { SegBlocks, type SegBlocksProps } from "./seg-blocks";
export { SkillOverlap, type SkillOverlapProps, type SkillOverlapSkill } from "./skill-overlap";
export { Sparkline, type SparklineProps } from "./sparkline";
export { Stacked100, type Stacked100Part, type Stacked100Props } from "./stacked-100";
export { Ticker, type TickerItem, type TickerProps } from "./ticker";
export { TermLog, type TermLine, type TermLogProps } from "./term-log";
export { UptimeStrip, type UptimeState, type UptimeStripProps } from "./uptime-strip";
export { Waffle, type WaffleProps } from "./waffle";
export { STEPS, stepStyle, type VizTone } from "./util";
