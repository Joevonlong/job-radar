import { notFound } from "next/navigation";

import {
  Battery,
  Delta,
  Freshness,
  Fraction,
  Funnel,
  Led,
  LevelScale,
  PairBars,
  PercentBar,
  Percentile,
  PercentText,
  Ring,
  SalaryAxis,
  SalaryMini,
  salaryAxisScale,
  ScoreComposition,
  ScoreMeter,
  SegBlocks,
  SkillOverlap,
  Sparkline,
  Stacked100,
  TermLog,
  Ticker,
  UptimeStrip,
  Waffle,
} from "@/components/viz";
import { reloadConfig } from "@/lib/config";

import { DevShell, Row, Sample, ShowCard } from "./dev-shell";
import { RollDemo } from "./roll-demo";

// Dev-only: every viz component in several states (0, middle, 100, unknown, out of range). 404 in production.
export const dynamic = "force-dynamic";

const NOW = new Date("2026-10-08T12:00:00Z");
const hoursAgo = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000);
const FLOOR_EUR = 70_000;
const MEDIAN_EUR = 96_000;

/** The push line and the signal-bonus cap the dev page shows; read from the config like any page would. */
function loadSettings(): { pushLine: number; trendCycles: number; healthCycles: number; tickerItems: number; axis: ReturnType<typeof salaryAxisScale>; freshness: { decay: number; warn: number } } {
  const ui = reloadConfig("ui");
  const notify = reloadConfig("notify");
  return {
    pushLine: notify.push_min_score,
    trendCycles: ui.trend_cycles,
    healthCycles: ui.health_cycles,
    tickerItems: ui.ticker_max_items,
    axis: salaryAxisScale(ui),
    freshness: { decay: ui.freshness.decay_hours, warn: ui.freshness.warn_hours },
  };
}

export default function Page() {
  if (process.env.NODE_ENV === "production") notFound();
  const { pushLine, trendCycles, healthCycles, tickerItems, axis, freshness } = loadSettings();

  const trend = [12, 14, 13, 18, 22, 21, 30, 28, 35].slice(-trendCycles);
  const states = ["ok", "ok", "ok", "warn", "ok", "ok", "fail", "ok", "ok", "ok", "ok", "warn", "ok", "ok", "ok", "ok"] as const;

  return (
    <DevShell>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 420px), 1fr))", gap: "var(--space-6)", alignItems: "start" }}>
          <ShowCard title="NumberRoll" aux="NumberFlow · only changed digits roll">
            <RollDemo />
          </ShowCard>

          <ShowCard title="ScoreMeter" aux={`20 / 10 cells · push line ${pushLine}`}>
            <Row>
              <Sample label="xl 88">
                <ScoreMeter value={88} pushLine={pushLine} size="xl" match={78} bonus={10} />
              </Sample>
              <Sample label="xl 106 (> 100, capped at 15)">
                <ScoreMeter value={106} pushLine={pushLine} size="xl" match={91} bonus={15} max={115} />
              </Sample>
            </Row>
            <Row>
              <Sample label="md 88">
                <ScoreMeter value={88} pushLine={pushLine} match={78} bonus={10} />
              </Sample>
              <Sample label="md 0">
                <ScoreMeter value={0} pushLine={pushLine} />
              </Sample>
              <Sample label="md 54">
                <ScoreMeter value={54} pushLine={pushLine} />
              </Sample>
              <Sample label="md 100">
                <ScoreMeter value={100} pushLine={pushLine} />
              </Sample>
              <Sample label="md null">
                <ScoreMeter value={null} pushLine={pushLine} />
              </Sample>
              <Sample label="md 130 (out of range)">
                <ScoreMeter value={130} pushLine={pushLine} />
              </Sample>
            </Row>
            <Row>
              <Sample label="sm 81">
                <ScoreMeter value={81} pushLine={pushLine} size="sm" />
              </Sample>
              <Sample label="sm 68">
                <ScoreMeter value={68} pushLine={pushLine} size="sm" />
              </Sample>
              <Sample label="sm null">
                <ScoreMeter value={null} pushLine={pushLine} size="sm" />
              </Sample>
            </Row>
          </ShowCard>

          <ShowCard title="ScoreComposition" aux="fit + bonus · 0–115">
            <Sample wide label="78 + 10">
              <ScoreComposition match={78} bonus={10} bonusCap={15} pushLine={pushLine} />
            </Sample>
            <Sample wide label="100 + 20 (bonus over the cap)">
              <ScoreComposition match={100} bonus={20} bonusCap={15} pushLine={pushLine} />
            </Sample>
            <Sample wide label="0 + 0">
              <ScoreComposition match={0} bonus={0} bonusCap={15} pushLine={pushLine} />
            </Sample>
            <Sample wide label="null">
              <ScoreComposition match={null} bonus={0} bonusCap={15} pushLine={pushLine} />
            </Sample>
          </ShowCard>

          <ShowCard title="SalaryAxis" aux={`€${axis.minK}–${axis.maxK}k · floor · median`}>
            <Sample wide label="stated 95–120k">
              <SalaryAxis min={95_000} max={120_000} axis={axis} floor={FLOOR_EUR} median={MEDIAN_EUR} />
            </Sample>
            <Sample wide label="below the floor 58–66k">
              <SalaryAxis min={58_000} max={66_000} axis={axis} floor={FLOOR_EUR} median={MEDIAN_EUR} />
            </Sample>
            <Sample wide label="other region ($140–170k ≈ €129–156k)">
              <SalaryAxis min={129_000} max={156_000} axis={axis} floor={FLOOR_EUR} median={MEDIAN_EUR} otherRegion figure="$140–170k" />
            </Sample>
            <Sample wide label="not disclosed">
              <SalaryAxis axis={axis} floor={FLOOR_EUR} median={MEDIAN_EUR} />
            </Sample>
            <Sample wide label="only a lower bound 90k+">
              <SalaryAxis min={90_000} axis={axis} floor={FLOOR_EUR} />
            </Sample>
            <Sample wide label="only an upper bound ≤120k">
              <SalaryAxis max={120_000} axis={axis} floor={FLOOR_EUR} />
            </Sample>
            <Sample wide label="range of many jobs 70–250k (/me): own name, cut at the axis end with » and a note">
              <SalaryAxis min={70_000} max={250_000} axis={axis} floor={FLOOR_EUR} median={MEDIAN_EUR} ariaLabel="Stated salary range this month €70–250k" />
            </Sample>
            <Sample wide label="out of the axis 190–260k">
              <SalaryAxis min={190_000} max={260_000} axis={axis} floor={FLOOR_EUR} median={MEDIAN_EUR} />
            </Sample>
          </ShowCard>

          <ShowCard title="SalaryMini" aux="for tables · mini axis">
            <Row>
              <Sample label="stated + percentile">
                <SalaryMini min={95_000} max={120_000} axis={axis} floor={FLOOR_EUR} percentile={72} />
              </Sample>
              <Sample label="below the floor">
                <SalaryMini min={58_000} max={66_000} axis={axis} floor={FLOOR_EUR} />
              </Sample>
            </Row>
            <Row>
              <Sample label="other region">
                <SalaryMini min={129_000} max={156_000} axis={axis} floor={FLOOR_EUR} otherRegion figure="$140–170k" />
              </Sample>
              <Sample label="not disclosed">
                <SalaryMini axis={axis} floor={FLOOR_EUR} />
              </Sample>
            </Row>
            <Row>
              <Sample label="upper bound only">
                <SalaryMini max={120_000} axis={axis} floor={FLOOR_EUR} />
              </Sample>
              <Sample label="lower bound only">
                <SalaryMini min={90_000} axis={axis} floor={FLOOR_EUR} />
              </Sample>
            </Row>
          </ShowCard>

          <ShowCard title="Percentile" aux="one bar + text">
            <Sample label="72">
              <Percentile value={72} />
            </Sample>
            <Sample label="0">
              <Percentile value={0} />
            </Sample>
            <Sample label="100">
              <Percentile value={100} />
            </Sample>
            <Sample label="null">
              <Percentile value={null} />
            </Sample>
          </ShowCard>

          <ShowCard title="PercentText" aux="XL 44 · L 32 · M 22">
            <Row>
              <Sample label="24 xl">
                <PercentText value={24} size="xl" />
              </Sample>
              <Sample label="24 l">
                <PercentText value={24} size="l" />
              </Sample>
              <Sample label="24 m">
                <PercentText value={24} size="m" />
              </Sample>
              <Sample label="2.64 → 2.6">
                <PercentText value={2.64} size="l" />
              </Sample>
              <Sample label="0.04 → <0.1">
                <PercentText value={0.04} size="l" />
              </Sample>
              <Sample label="0">
                <PercentText value={0} size="l" />
              </Sample>
              <Sample label="100">
                <PercentText value={100} size="l" />
              </Sample>
              <Sample label="null">
                <PercentText value={null} size="l" />
              </Sample>
              <Sample label="roll 41.4">
                <PercentText value={41.4} size="l" roll />
              </Sample>
            </Row>
          </ShowCard>

          <ShowCard title="PercentBar" aux="sm 7 · md 10 · lg 14">
            <Sample label="sm 29.5% / fetched">
              <PercentBar value={29.5} size="sm" label="29.5% / fetched" />
            </Sample>
            <Sample label="md 46">
              <PercentBar value={46} tone="meter" />
            </Sample>
            <Sample label="lg 76 hi + line 80">
              <PercentBar value={76} size="lg" tone="hi" threshold={80} />
            </Sample>
            <Sample label="0">
              <PercentBar value={0} />
            </Sample>
            <Sample label="100 / 140 (out of range)">
              <Row>
                <PercentBar value={100} tone="good" />
                <PercentBar value={140} tone="bad" />
              </Row>
            </Sample>
            <Sample label="null">
              <PercentBar value={null} />
            </Sample>
          </ShowCard>

          <ShowCard title="Fraction" aux="part / whole">
            <Row>
              <Sample label="62 / 135">
                <Fraction part={62} whole={135} unit="jobs" />
              </Sample>
              <Sample label="184 / 200 over the line">
                <Fraction part={184} whole={200} unit="pages" tone="bad" threshold={80} />
              </Sample>
            </Row>
            <Row>
              <Sample label="0 / 135">
                <Fraction part={0} whole={135} unit="jobs" />
              </Sample>
              <Sample label="0 / 0">
                <Fraction part={0} whole={0} />
              </Sample>
              <Sample label="null / 135">
                <Fraction part={null} whole={135} />
              </Sample>
            </Row>
          </ShowCard>

          <ShowCard title="SegBlocks" aux="10 cells">
            <Row>
              <Sample label="0">
                <SegBlocks value={0} />
              </Sample>
              <Sample label="40">
                <SegBlocks value={40} />
              </Sample>
              <Sample label="80 hi">
                <SegBlocks value={80} tone="hi" />
              </Sample>
              <Sample label="100 good">
                <SegBlocks value={100} tone="good" />
              </Sample>
              <Sample label="null">
                <SegBlocks value={null} />
              </Sample>
              <Sample label="160 (out of range)">
                <SegBlocks value={160} />
              </Sample>
            </Row>
          </ShowCard>

          <ShowCard title="Waffle" aux="S 6px · M 10px">
            <Row>
              <Sample label="41 t4">
                <Waffle value={41} tone="t4" />
              </Sample>
              <Sample label="S 41">
                <Waffle value={41} size="s" tone="t4" />
              </Sample>
              <Sample label="0">
                <Waffle value={0} size="s" />
              </Sample>
              <Sample label="100">
                <Waffle value={100} size="s" />
              </Sample>
              <Sample label="null">
                <Waffle value={null} size="s" />
              </Sample>
            </Row>
          </ShowCard>

          <ShowCard title="Ring" aux="S 48 · M 84 · L 110">
            <Row>
              <Sample label="S 46">
                <Ring value={46} size="s" caption="62/135" />
              </Sample>
              <Sample label="M 76">
                <Ring value={76} tone="hi" caption="76%" />
              </Sample>
              <Sample label="L 24">
                <Ring value={24} size="l" tone="t2" caption="24/100" />
              </Sample>
            </Row>
            <Row>
              <Sample label="0">
                <Ring value={0} size="s" />
              </Sample>
              <Sample label="100">
                <Ring value={100} size="s" tone="good" />
              </Sample>
              <Sample label="null">
                <Ring value={null} size="s" />
              </Sample>
              <Sample label="150 (out of range)">
                <Ring value={150} size="s" />
              </Sample>
            </Row>
          </ShowCard>

          <ShowCard title="Battery" aux="10 cells + red line">
            <Row>
              <Sample label="41 / line 80">
                <Battery value={41} threshold={80} />
              </Sample>
              <Sample label="76 hi">
                <Battery value={76} threshold={80} tone="hi" />
              </Sample>
              <Sample label="92 (over)">
                <Battery value={92} threshold={80} />
              </Sample>
            </Row>
            <Row>
              <Sample label="0">
                <Battery value={0} threshold={80} />
              </Sample>
              <Sample label="100">
                <Battery value={100} threshold={80} />
              </Sample>
              <Sample label="null">
                <Battery value={null} threshold={80} />
              </Sample>
            </Row>
          </ShowCard>

          <ShowCard title="Stacked100" aux="100% stacked">
            <Stacked100
              parts={[
                { key: "interested", label: "Interested", value: 3, tone: "hi" },
                { key: "preparing", label: "Preparing", value: 1, tone: "t4" },
                { key: "applied", label: "Applied", value: 2, tone: "t3" },
                { key: "interview", label: "Interviewing", value: 1, tone: "t2" },
              ]}
            />
            <Sample wide label="one part">
              <Stacked100 parts={[{ key: "a", label: "Interested", value: 5, tone: "hi" }]} />
            </Sample>
            <Sample wide label="empty (all 0)">
              <Stacked100 parts={[{ key: "a", label: "Interested", value: 0, tone: "hi" }]} />
            </Sample>
          </ShowCard>

          <ShowCard title="Delta + PairBars" aux="▲ ▼ ■">
            <Row>
              <Sample label="+12">
                <Delta value={12} />
              </Sample>
              <Sample label="−3">
                <Delta value={-3} />
              </Sample>
              <Sample label="0">
                <Delta value={0} />
              </Sample>
              <Sample label="+2pt">
                <Delta value={2} unit="pt" />
              </Sample>
              <Sample label="+18%">
                <Delta value={18} unit="%" />
              </Sample>
              <Sample label="−4 inverted (failures)">
                <Delta value={-4} invert />
              </Sample>
              <Sample label="null">
                <Delta value={null} />
              </Sample>
            </Row>
            <Row>
              <Sample label="123 → 135">
                <PairBars prev={123} now={135} max={160} showDelta caption="123 → 135" />
              </Sample>
              <Sample label="36 → 38 (pt)">
                <PairBars prev={36} now={38} max={50} caption="pass rate 36% → 38%" />
              </Sample>
            </Row>
            <Row>
              <Sample label="0 → 0">
                <PairBars prev={0} now={0} />
              </Sample>
              <Sample label="prev unknown">
                <PairBars prev={null} now={20} max={50} />
              </Sample>
            </Row>
          </ShowCard>

          <ShowCard title="Sparkline" aux={`step line · last ${trendCycles} runs`}>
            <Row>
              <Sample label="trend">
                <Sparkline values={trend} />
              </Sample>
              <Sample label="flat">
                <Sparkline values={[5, 5, 5, 5, 5]} />
              </Sample>
              <Sample label="all 0">
                <Sparkline values={[0, 0, 0, 0]} />
              </Sample>
              <Sample label="one value">
                <Sparkline values={[7]} />
              </Sample>
            </Row>
            <Row>
              <Sample label="gap (null) in the middle">
                <Sparkline values={[3, 6, null, 9, 12, 10]} />
              </Sample>
              <Sample label="percent">
                <Sparkline values={[36, 38, 35, 41, 44]} format="percent" />
              </Sample>
              <Sample label="no data">
                <Sparkline values={[]} />
              </Sample>
              <Sample label="all unknown">
                <Sparkline values={[null, null, null]} />
              </Sample>
            </Row>
          </ShowCard>

          <ShowCard title="LevelScale" aux="CEFR · you / required / gap">
            <Sample label="B1, needs B2">
              <LevelScale mine="B1" required="B2" />
            </Sample>
            <Sample label="A2, needs C1">
              <LevelScale mine="A2" required="C1" />
            </Sample>
            <Sample label="C2, needs B2">
              <LevelScale mine="C2" required="B2" />
            </Sample>
            <Sample label="B2, needs B2">
              <LevelScale mine="B2" required="B2" />
            </Sample>
            <Sample label="B1, no requirement">
              <LevelScale mine="B1" />
            </Sample>
            <Sample label="not set, needs B2">
              <LevelScale mine={null} required="B2" />
            </Sample>
            <Sample label="not set, no requirement">
              <LevelScale mine={null} />
            </Sample>
          </ShowCard>

          <ShowCard title="SkillOverlap" aux="one cell per skill">
            <Row>
              <Sample label="4/7">
                <SkillOverlap skills={[{ name: "Python", have: true }, { name: "LLMs", have: true }, { name: "RAG", have: true }, { name: "Kubernetes", have: true }, { name: "AWS", have: false }, { name: "LangChain", have: false }, { name: "Vector DB", have: false }]} />
              </Sample>
              <Sample label="0/3">
                <SkillOverlap skills={[{ name: "GCP", have: false }, { name: "Azure", have: false }, { name: "JAX", have: false }]} />
              </Sample>
              <Sample label="3/3">
                <SkillOverlap skills={[{ name: "Python", have: true }, { name: "SQL", have: true }, { name: "dbt", have: true }]} />
              </Sample>
              <Sample label="no skills listed">
                <SkillOverlap skills={[]} />
              </Sample>
            </Row>
          </ShowCard>

          <ShowCard title="Freshness" aux={`decays over ${freshness.decay} h · yellow after ${freshness.warn} h`}>
            <Row>
              <Sample label="12 min">
                <Freshness firstSeenAt={hoursAgo(0.2)} now={NOW} decayHours={freshness.decay} warnHours={freshness.warn} />
              </Sample>
              <Sample label="2 h">
                <Freshness firstSeenAt={hoursAgo(2)} now={NOW} decayHours={freshness.decay} warnHours={freshness.warn} />
              </Sample>
              <Sample label="26 h">
                <Freshness firstSeenAt={hoursAgo(26)} now={NOW} decayHours={freshness.decay} warnHours={freshness.warn} />
              </Sample>
              <Sample label="70 h">
                <Freshness firstSeenAt={hoursAgo(70)} now={NOW} decayHours={freshness.decay} warnHours={freshness.warn} />
              </Sample>
              <Sample label="200 h (past the decay)">
                <Freshness firstSeenAt={hoursAgo(200)} now={NOW} decayHours={freshness.decay} warnHours={freshness.warn} />
              </Sample>
              <Sample label="unknown">
                <Freshness firstSeenAt={null} now={NOW} decayHours={freshness.decay} warnHours={freshness.warn} />
              </Sample>
            </Row>
          </ShowCard>

          <ShowCard title="Funnel" aux="fetched → filtered → ≥70 → pushed">
            <Funnel
              steps={[
                { key: "fetched", label: "Fetched", value: 458, tone: "ink" },
                { key: "passed", label: "Passed the filter", value: 135, tone: "t4" },
                { key: "scored", label: `≥ ${pushLine}`, value: 24, tone: "t2" },
                { key: "pushed", label: "Pushed", value: 6, tone: "hi" },
              ]}
            />
            <Sample wide label="zeros">
              <Funnel steps={[{ key: "a", label: "Fetched", value: 0 }, { key: "b", label: "Passed the filter", value: 0 }]} />
            </Sample>
          </ShowCard>

          <ShowCard title="UptimeStrip" aux={`last ${healthCycles} runs`}>
            <Sample label={`${states.length} cycles, last ${healthCycles}`}>
              <UptimeStrip states={[...states]} count={healthCycles} />
            </Sample>
            <Sample label="only 5 cycles so far">
              <UptimeStrip states={["ok", "ok", "fail", "ok", "warn"]} count={healthCycles} />
            </Sample>
            <Sample label="no data">
              <UptimeStrip states={[]} count={healthCycles} />
            </Sample>
          </ShowCard>

          <ShowCard title="Led" aux="light + text">
            <Row>
              <Sample label="good">
                <Led tone="good" />
              </Sample>
              <Sample label="good live">
                <Led tone="good" live label="Running" />
              </Sample>
              <Sample label="warn">
                <Led tone="warn" />
              </Sample>
              <Sample label="bad">
                <Led tone="bad" />
              </Sample>
              <Sample label="idle">
                <Led tone="idle" />
              </Sample>
            </Row>
          </ShowCard>

          <ShowCard title="Ticker" aux="LIVE · pauses on hover">
            <Ticker
              maxItems={tickerItems}
              items={[
                { key: "1", tag: "NEW", text: "Senior Applied AI Engineer · Fernwerk AI", accent: "€95–120k · 88" },
                { key: "2", tag: "NEW", text: "Forward Deployed Engineer · Kobalt Health · not disclosed", accent: "81" },
                { key: "3", tag: "NEW", text: "NLP Engineer · Nordlicht Systems", accent: "€85–100k · awaiting score" },
                { key: "4", tag: "RUN", text: "Evening run 17:00 done · 458 fetched · 135 passed · 6 pushed" },
                { key: "5", tag: "SRC", text: "guest paused · retry 07:00 tomorrow" },
              ]}
            />
            <Sample wide label="empty">
              <Ticker items={[]} />
            </Sample>
          </ShowCard>

          <ShowCard title="TermLog" aux="typed line by line">
            <TermLog
              lines={[
                { prefix: "17:00", text: "cycle weekday_evening start", tone: "amber" },
                { prefix: "17:01", text: "linkedin-guest  458 fetched", tone: "ink" },
                { prefix: "17:02", text: "filter  135 passed · 323 dropped", tone: "green" },
                { prefix: "17:04", text: "score   62/135 …", tone: "dim" },
              ]}
            />
          </ShowCard>
        </div>
    </DevShell>
  );
}
