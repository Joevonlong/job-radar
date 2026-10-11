/**
 * The registry of forms with unsaved edits (settings, profile, interests). A form registers while it is dirty; the shell's
 * `UnsavedGuard` reads it to warn before the page is left (reload / close tab through `beforeunload`, in-app links and the
 * command palette through `requestLeave`). A module-level store so any number of mounted forms (every settings tab stays
 * mounted) share one dialog.
 */
const dirtyIds = new Set<string>();
const listeners = new Set<() => void>();
let pendingHref: string | null = null;
let version = 0;

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeUnsaved(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Snapshot for `useSyncExternalStore`: changes whenever the registry or the pending destination changes. */
export function unsavedVersion(): number {
  return version;
}

/** Mark a form dirty; returns the function that marks it clean again. */
export function registerUnsaved(id: string): () => void {
  dirtyIds.add(id);
  emit();
  return () => {
    dirtyIds.delete(id);
    emit();
  };
}

/** The form that became dirty most recently (a Set keeps insertion order); null when nothing is unsaved. */
export function lastUnsavedId(): string | null {
  let last: string | null = null;
  for (const id of dirtyIds) last = id;
  return last;
}

export function hasUnsaved(): boolean {
  return dirtyIds.size > 0;
}

/** The destination the user wanted when the guard stopped them; null when no dialog is open. */
export function getPendingLeave(): string | null {
  return pendingHref;
}

export function clearPendingLeave(): void {
  if (pendingHref === null) return;
  pendingHref = null;
  emit();
}

/**
 * Ask to leave for `href`. True: nothing is unsaved, go. False: the guard now shows its dialog and navigates itself if the
 * user chooses to drop the edits.
 */
export function requestLeave(href: string): boolean {
  if (!hasUnsaved()) return true;
  pendingHref = href;
  emit();
  return false;
}
