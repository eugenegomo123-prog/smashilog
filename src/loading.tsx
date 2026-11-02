// The "still fetching" placeholder shown while a page or tab waits on its
// data: a small spinner over the word "Loading…", in the same centered grey
// spot the plain text used to sit in. `screen` is for when it's the whole
// page (before a session/page has loaded at all) rather than one tab's body.
export function Loading({ screen = false }: { screen?: boolean }) {
  return (
    <div className={`${screen ? "screen " : ""}empty-state`} role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      Loading…
    </div>
  );
}
