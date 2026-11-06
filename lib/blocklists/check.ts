/** One budgeted query against one list. */
import { takeQuery, type QueryPurpose } from "./budget";
import { blocklistLookup } from "./dns";
import { classifyAnswer, queryName, type BlocklistId, type Verdict } from "./lists";
import { dqsKey } from "./status";

export type QueryOutcome = Verdict | { kind: "skipped"; why: "no_key" | "budget" | "bad_name" };

export async function queryList(list: BlocklistId, domain: string, purpose: QueryPurpose, now: Date, timeoutMs: number): Promise<QueryOutcome> {
  const key = dqsKey();
  if (!key) return { kind: "skipped", why: "no_key" };
  const name = queryName(list, domain, key);
  if (!name) return { kind: "skipped", why: "bad_name" };
  if (!(await takeQuery(purpose, now))) return { kind: "skipped", why: "budget" };
  try {
    return classifyAnswer(list, await blocklistLookup()(name, timeoutMs));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { kind: "error", error: code === "ETIMEOUT" || code === "ECANCELLED" ? "timeout" : "lookup_failed" };
  }
}
