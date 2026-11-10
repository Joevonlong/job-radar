/**
 * Config system (layered). YAML is the single source of truth; everything is validated with zod.
 *
 * Locations (relative values resolve against the app root, not cwd):
 * - `JOB_RADAR_DEFAULTS_DIR` (default `<job-radar>/config`): shipped defaults, tracked in git, read-only.
 * - `JOB_RADAR_CONFIG_DIR` (default `<job-radar>/data/config`): the user's files; a file here wins, every write lands here.
 * - `JOB_RADAR_PROFILE_DIR` (default `<job-radar>/data/profile`): me.yaml / preferences.yaml.
 * A value is the shipped file with the user's file merged over it, key by key (`key: !unset` removes a key). A user file from
 * before that format is a whole file and read as one; a deploy's write step converts it. Each file may carry
 * `config_version` (missing = 1); older files are migrated in memory on load (`migrations/`).
 */
export * from "./errors";
export { changedKeyPaths, diffYaml, type DiffLine } from "./diff";
export {
  applyExamplePlan,
  ConfigExampleError,
  examplesDir,
  listExamples,
  mergeExample,
  planExample,
  readExample,
  type AppliedConfigExample,
  type ConfigExample,
  type ConfigExampleChange,
  type ConfigExampleInfo,
} from "./examples";
export { freshenConfig } from "./fresh";
export { hashConfigText, layeredConfigFingerprint, layeredFingerprint } from "./hash";
export {
  configSourcePath,
  loadConfig,
  fileLacksVersion,
  parseConfigDocument,
  parseConfigText,
  parseConfigTextWithVersion,
  readConfigLayers,
  readConfigText,
  readEffectiveConfig,
  readEffectiveRaw,
  readProfileText,
  refreshConfigCache,
  readShippedConfig,
  reloadConfig,
  reloadConfigWithFingerprint,
  resetConfigCache,
  validateConfigValue,
  type ConfigRefreshResult,
} from "./load";
export { loadCompanies } from "./ats-boards";
export * from "./model-catalog";
export {
  configLayer,
  displayConfigPath,
  displayConfigPathForWeb,
  getAppRoot,
  getDataRoot,
  getConfigDir,
  getConfigPath,
  getDefaultConfigPath,
  getDefaultsDir,
  getPollIntervalMs,
  getProfileDir,
  getProfileExampleDir,
  getUserConfigPath,
  readOverlayText,
  readShippedText,
  resolveConfigPath,
  type ConfigLayer,
} from "./paths";
export { ensureConfigFiles, plannedConfigFiles, type EnsureConfigOptions, type EnsureConfigResult } from "./init";
export { installedConfigFiles } from "./install";
export { commitConfigFile, publishNoReplace, sha256 } from "./atomic";
export { configWriteSettings, withConfigWriteLock } from "./write-lock";
export { inspectModelsOverlay, mergeModelsOverlay, type OverlayInspection } from "./models-overlay";
export { inspectConfigLayers, inspectOverlayFiles, type ConfigFileOverlay, type ConfigLayersState } from "./layers";
export { changedDefaults, countOverlayEntries, overlayEntries, shownValue, type ChangedDefault, type OverlayCounts, type OverlayEntry } from "./overlay-report";
export { CONFIG_MIGRATIONS, type ConfigMigration } from "./migrations/index";
export {
  assertMigrationChain,
  CONFIG_VERSION_KEY,
  configMigrations,
  currentConfigVersion,
  documentConfigVersion,
  hasOverlayFormat,
  isOverlayVersion,
  legacyFormatVersion,
  migrateConfigDocument,
  overlayFormatVersion,
  stampConfigVersion,
  withoutConfigVersion,
  type DocumentMigrationResult,
} from "./migrations/version";
export {
  applyConfigMigrations,
  configBackupDir,
  planConfigMigrations,
  type AppliedConfigMigrations,
  type ConfigMigrationPlan,
  type FileMigration,
  type FileMigrationProblem,
} from "./migrations/files";
export { applyToFull, planToFull, restoreConfigBackup, type AppliedToFull, type ToFullItem, type ToFullPlan } from "./migrations/rollback";
export { newFileFormat, type NewFileFormat } from "./new-file-format";
export { pruneConfigBackups } from "./migrations/backups";
export { DEPLOY_WRITE_PLAN, planConfigWrites, type ConfigWritesPlan, type PlannedConfigWrite } from "./migrations/plan-writes";
export { ensureProfileFiles, ensureProfileFilesPlan, setOnProfileSaved, type EnsureProfileResult, type ProfileSavedHook, type ProfileSavedResult } from "./profile";
export {
  CONFIG_NAMES,
  configRegistry,
  isProfileName,
  LAYERED_CONFIG_NAMES,
  OVERLAID_CONFIG_NAMES,
  PROFILE_NAMES,
  SHIPPED_CONFIG_NAMES,
  USER_CONFIG_NAMES,
  type ConfigName,
  type ConfigValue,
  type ProfileName,
} from "./registry";
export * from "./schemas";
export { watchConfig, type ConfigChangeEvent, type ConfigTarget, type WatchDirectory, type WatchOptions } from "./watch";
export { mutateConfig, newFileText, overlayStubText, wholeFileText, withFileLock, writeConfig, writeConfigRepair, writeConfigText, resetConfigToDefault, type TextBase, type TextWriteOptions, type TextWriteResult } from "./write";
export { backupConfigText, editorBackupRoot } from "./editor-backup";
export { maskConfigText, restoreMaskedText, type RestoreResult } from "./secrets-mask";
export { interestsRawWarnings, interestsWarnings, SLOW_PATTERN_MESSAGE, slowInterestPatterns, type InterestsWarning, type SlowInterestPattern } from "./interests-lint";
export { locatePath, MAX_TEXT_ISSUES, validateConfigText, type IssueSource, type TextIssue, type ValidateOptions, type ValidateResult } from "./validate-text";
