/**
 * Config system (layered). YAML is the single source of truth (C8); everything is validated with zod (C6).
 *
 * Locations (relative values resolve against the app root, not cwd):
 * - `JOB_RADAR_DEFAULTS_DIR` (default `<job-radar>/config`): shipped defaults, tracked in git, read-only.
 * - `JOB_RADAR_CONFIG_DIR` (default `<job-radar>/data/config`): the user's files; a file here wins, every write lands here.
 * - `JOB_RADAR_PROFILE_DIR` (default `<job-radar>/data/profile`): me.yaml / preferences.yaml.
 * Each file may carry `config_version` (missing = 1); older files are migrated in memory on load (`migrations/`).
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
export { hashConfigText } from "./hash";
export {
  configSourcePath,
  loadConfig,
  parseConfigDocument,
  parseConfigText,
  parseConfigTextWithVersion,
  readConfigText,
  refreshConfigCache,
  reloadConfig,
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
  resolveConfigPath,
  type ConfigLayer,
} from "./paths";
export { ensureConfigFiles, existingInstallSetupYaml, type EnsureConfigOptions, type EnsureConfigResult } from "./init";
export { installedConfigFiles, isExistingInstall } from "./install";
export { inspectConfigLayers, type ConfigLayersState } from "./layers";
export { CONFIG_MIGRATIONS, type ConfigMigration } from "./migrations/index";
export {
  assertMigrationChain,
  CONFIG_VERSION_KEY,
  configMigrations,
  currentConfigVersion,
  documentConfigVersion,
  migrateConfigDocument,
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
export { ensureProfileFiles, setOnProfileSaved, type EnsureProfileResult, type ProfileSavedHook } from "./profile";
export {
  CONFIG_NAMES,
  configRegistry,
  isProfileName,
  LAYERED_CONFIG_NAMES,
  PROFILE_NAMES,
  SHIPPED_CONFIG_NAMES,
  USER_CONFIG_NAMES,
  type ConfigName,
  type ConfigValue,
  type ProfileName,
} from "./registry";
export * from "./schemas";
export { watchConfig, type ConfigChangeEvent, type ConfigTarget, type WatchOptions } from "./watch";
export { writeConfig, writeConfigText, resetConfigToDefault, type TextBase, type TextWriteOptions, type TextWriteResult } from "./write";
export { backupConfigText, editorBackupRoot } from "./editor-backup";
export { maskConfigText, restoreMaskedText, type RestoreResult } from "./secrets-mask";
export { interestsWarnings, type InterestsWarning } from "./interests-lint";
export { locatePath, MAX_TEXT_ISSUES, validateConfigText, type IssueSource, type TextIssue, type ValidateOptions, type ValidateResult } from "./validate-text";
