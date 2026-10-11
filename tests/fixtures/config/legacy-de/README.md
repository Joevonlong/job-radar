# legacy-de

Config files as they were before the market packs (config_version 1, Germany only), copied from the frozen
fixture `tests/fixtures/config/defaults` of main 74d9500. `tests/market/migration-equivalence.test.ts` migrates them,
computes the effective config under the DE pack and checks it equals the original. The search criteria in preferences / search / insights are fictional (neutral keywords, Hamburg / Köln, a 50,000 floor); the migration test does not depend on their values. Do not edit the other files.
