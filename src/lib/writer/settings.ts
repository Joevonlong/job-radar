/** Web side: the files the writer reads, fresh on every call (the web app has no config watcher). Server only. */
import { ConfigError, reloadConfig, type MeConfig, type Story, type WriterConfig } from "@/lib/config";

export interface WriterInputs {
  /** null: writer.yaml cannot be read. */
  writer: WriterConfig | null;
  /** null: me.yaml cannot be read (the profile cannot be sent). */
  me: MeConfig | null;
  /** Empty when stories.yaml cannot be read. */
  stories: Story[];
  /** stories.yaml exists but cannot be read (a syntax or format error); fix it on /me. */
  storiesUnreadable: boolean;
  /** breakdown.yaml's switch (false while the file cannot be read): whether the page offers a breakdown first. */
  breakdownEnabled: boolean;
}

function read<T>(load: () => T, fallback: T): T {
  try {
    return load();
  } catch (error) {
    if (error instanceof ConfigError) return fallback;
    throw error;
  }
}

export function readWriterInputs(): WriterInputs {
  const stories = read<Story[] | null>(() => reloadConfig("stories").stories, null);
  return {
    writer: read<WriterConfig | null>(() => reloadConfig("writer"), null),
    me: read<MeConfig | null>(() => reloadConfig("me"), null),
    stories: stories ?? [],
    storiesUnreadable: stories === null,
    breakdownEnabled: read(() => reloadConfig("breakdown").enabled, false),
  };
}

/** writer.yaml says the writer is on (false while the file cannot be read). */
export function readWriterEnabled(): boolean {
  return read(() => reloadConfig("writer").enabled, false);
}
