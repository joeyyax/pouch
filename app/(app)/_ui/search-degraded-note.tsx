/** Shown when a configured search index didn't answer and the list fell back to exact matches. */
export function SearchDegradedNote() {
  return (
    <p role="status" className="type-body-sm pb-3 text-muted-foreground">
      Typo-tolerant search didn’t answer, so these are exact matches only.
    </p>
  );
}
