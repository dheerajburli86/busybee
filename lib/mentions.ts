// Checklist #30: @tags. One rule for turning a name into a tag, shared by the
// suggestion box (MentionTextarea) and the server (comments route), so what
// the box offers is exactly what the server recognises.

/** "Sales & Marketing" -> "salesmarketing", "Asha Rao" -> "asharao". */
export function handleFor(name: string | null | undefined): string {
  return (name || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "");
}

/** The tags in a piece of text, without the "@" or trailing punctuation. */
export function mentionsIn(text: string): string[] {
  // Require the "@" to start the text or follow whitespace, so an email
  // address (bob@example.com) doesn't get misread as a mention of
  // "example.com" - only a real "@handle" token preceded by a boundary
  // counts.
  const found = (text.match(/(?:^|\s)@[A-Za-z0-9._-]+/g) || []).map((m) =>
    m.trim().slice(1).toLowerCase().replace(/[._-]+$/, "")
  );
  return Array.from(new Set(found.filter(Boolean)));
}
