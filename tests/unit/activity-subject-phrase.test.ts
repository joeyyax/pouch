import { describe, expect, it } from "vitest";
import { actionPhrase, subjectPhrase, type SubjectPart } from "@/lib/dashboard/views/activity-phrase";

const subject = (id: string, label: string) => ({ id, label, href: null });
const words = (parts: SubjectPart[]) => parts.map((part) => (part.kind === "text" ? part.text : part.subject.label));

describe("subjectPhrase", () => {
  it("drops the count when every subject is named", () => {
    const phrase = subjectPhrase({ family: "key", count: 3, subjects: [subject("a", "A"), subject("b", "B"), subject("c", "C")] });
    expect(words(phrase.parts)).toEqual(["A", "B", "C"]);
    expect(phrase).toMatchObject({ more: 0, showCount: false });
  });

  it("keeps the count when names are cut short", () => {
    const subjects = ["A", "B", "C", "D", "E", "F"].map((label) => subject(label, label));
    const phrase = subjectPhrase({ family: "key", count: 6, subjects });
    expect(words(phrase.parts)).toEqual(["A", "B", "C"]);
    expect(phrase).toMatchObject({ more: 3, showCount: true });
  });

  it("keeps the count when one subject repeats", () => {
    expect(subjectPhrase({ family: "key", count: 2, subjects: [subject("a", "A")] }).showCount).toBe(true);
  });

  it("keeps the count when there's no subject at all", () => {
    expect(subjectPhrase({ family: "session", count: 9, subjects: [] }).showCount).toBe(true);
  });

  it("counts unnamed subjects instead of repeating the placeholder", () => {
    const subjects = ["s1", "s2", "s3"].map((id) => subject(id, "a removed address"));
    const phrase = subjectPhrase({ family: "suppression", count: 3, subjects });
    expect(words(phrase.parts)).toEqual(["3 removed addresses"]);
    expect(phrase.showCount).toBe(false);
  });

  it("names what it can and counts the rest", () => {
    const subjects = [subject("s1", "one@example.com"), subject("s2", "a removed address"), subject("s3", "a removed address")];
    expect(words(subjectPhrase({ family: "suppression", count: 3, subjects }).parts)).toEqual([
      "one@example.com",
      "2 removed addresses",
    ]);
    expect(words(subjectPhrase({ family: "suppression", count: 1, subjects: [subject("s2", "a removed address")] }).parts)).toEqual([
      "a removed address",
    ]);
  });
});

describe("actionPhrase", () => {
  const removed = (id: string) => subject(id, "a removed address");

  it("counts a run of unnamed suppressions in the verb", () => {
    const group = { action: "suppression.removed", family: "suppression" as const, count: 3, subjects: ["s1", "s2", "s3"].map(removed) };
    expect(actionPhrase(group)).toEqual({ text: "removed 3 suppressions", standalone: true, showCount: false });
  });

  it("goes plural when a run names more than one", () => {
    const group = {
      action: "suppression.removed",
      family: "suppression" as const,
      count: 2,
      subjects: [subject("s1", "one@example.com"), removed("s2")],
    };
    expect(actionPhrase(group)).toMatchObject({ text: "removed suppressions on", standalone: false });
  });

  it("keeps the singular for one", () => {
    const group = { action: "suppression.removed", family: "suppression" as const, count: 1, subjects: [removed("s1")] };
    expect(actionPhrase(group)).toMatchObject({ text: "removed the suppression on", standalone: false, showCount: false });
  });

  it("leaves actions without a plural alone", () => {
    const group = { action: "key.revoked", family: "key" as const, count: 2, subjects: [subject("a", "A"), subject("b", "B")] };
    expect(actionPhrase(group)).toEqual({ text: "revoked key", standalone: false, showCount: false });
  });
});
