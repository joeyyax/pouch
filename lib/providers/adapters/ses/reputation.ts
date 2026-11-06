import { ListRecommendationsCommand } from "@aws-sdk/client-sesv2";
import { GetMetricDataCommand, type MetricDataQuery } from "@aws-sdk/client-cloudwatch";
import type { AccountRates, MetricRead, TenantFinding, TenantFindings, TenantVolume } from "../types";
import { log, type SesContext } from "./client";
import { isAccessDenied, reasonOf } from "./errors";
import { tenantIdFromArn, tenantNameFromArn } from "./tenants";

/** The permission a CloudWatch read needs. */
export const CLOUDWATCH_PERMISSION = "cloudwatch:GetMetricData";

/** How far back the account's reputation rates are read. SES publishes them a few times a day. */
export const REPUTATION_LOOKBACK_HOURS = 24;

/** The most findings ListRecommendations returns per page. */
const RECOMMENDATIONS_PAGE_SIZE = 100;

export function createReputation(context: SesContext) {
  const { cloudWatchClient, controlClient, paced } = context;

  async function metricData(queries: MetricDataQuery[], startTime: Date, endTime: Date) {
    const response = await cloudWatchClient.send(
      new GetMetricDataCommand({ StartTime: startTime, EndTime: endTime, ScanBy: "TimestampDescending", MetricDataQueries: queries }),
    );
    return new Map((response.MetricDataResults ?? []).map((result) => [result.Id ?? "", result]));
  }

  function refused<T>(err: unknown, what: string): MetricRead<T> {
    if (isAccessDenied(err)) return { state: "denied", permission: CLOUDWATCH_PERMISSION };
    log.warn(`reading ${what} failed: ${reasonOf(err)}`);
    return { state: "failed" };
  }

  async function reputationRates(): Promise<MetricRead<AccountRates>> {
    const end = new Date();
    const start = new Date(end.getTime() - REPUTATION_LOOKBACK_HOURS * 60 * 60 * 1000);
    const query = (id: string, metricName: string): MetricDataQuery => ({
      Id: id,
      MetricStat: { Metric: { Namespace: "AWS/SES", MetricName: metricName }, Period: 3600, Stat: "Average" },
      ReturnData: true,
    });
    try {
      const results = await metricData([query("bounce", "Reputation.BounceRate"), query("complaint", "Reputation.ComplaintRate")], start, end);
      const bounce = results.get("bounce");
      const complaint = results.get("complaint");
      const times = [bounce?.Timestamps?.[0], complaint?.Timestamps?.[0]].filter((at): at is Date => at instanceof Date);
      return {
        state: "ok",
        value: {
          bounceRate: bounce?.Values?.[0] ?? null,
          complaintRate: complaint?.Values?.[0] ?? null,
          at: times.length > 0 ? new Date(Math.max(...times.map((at) => at.getTime()))) : null,
        },
      };
    } catch (err) {
      return refused(err, "the account's reputation rates");
    }
  }

  async function tenantVolume(ref: string, days: number): Promise<MetricRead<TenantVolume>> {
    const name = tenantNameFromArn(ref);
    const id = tenantIdFromArn(ref);
    if (!name || !id) return { state: "failed" };
    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    const query = (queryId: string, metricName: string): MetricDataQuery => ({
      Id: queryId,
      MetricStat: {
        Metric: {
          Namespace: "AWS/SES",
          MetricName: metricName,
          Dimensions: [
            { Name: "TenantId", Value: id },
            { Name: "TenantName", Value: name },
          ],
        },
        Period: days * 24 * 60 * 60,
        Stat: "Sum",
      },
      ReturnData: true,
    });
    try {
      const results = await metricData([query("sends", "Sends"), query("bounces", "Bounces"), query("complaints", "Complaints")], start, end);
      const sum = (queryId: string) => (results.get(queryId)?.Values ?? []).reduce((total, value) => total + value, 0);
      return { state: "ok", value: { sends: sum("sends"), bounces: sum("bounces"), complaints: sum("complaints") } };
    } catch (err) {
      return refused(err, `tenant ${name}'s counts`);
    }
  }

  async function tenantFindings(maxPages: number, spacing: () => Promise<void>): Promise<TenantFindings | null> {
    const findings: TenantFinding[] = [];
    let token: string | undefined;
    let pages = 0;
    try {
      do {
        if (pages > 0) await spacing();
        const response = await paced(() => controlClient.send(
          new ListRecommendationsCommand({ Filter: { STATUS: "OPEN" }, NextToken: token, PageSize: RECOMMENDATIONS_PAGE_SIZE }),
        ));
        pages += 1;
        for (const recommendation of response.Recommendations ?? []) {
          const ref = recommendation.ResourceArn;
          if (!ref?.includes(":tenant/") || !recommendation.Type) continue;
          findings.push({
            tenantRef: ref,
            tenantName: tenantNameFromArn(ref),
            type: recommendation.Type,
            impact: recommendation.Impact ?? null,
            description: recommendation.Description ?? null,
            openedAt: recommendation.CreatedTimestamp ?? null,
          });
        }
        token = response.NextToken;
      } while (token && pages < maxPages);
      return { findings, complete: !token };
    } catch (err) {
      log.warn(`listing reputation findings failed: ${reasonOf(err)}`);
      return null;
    }
  }

  return { reputationRates, tenantVolume, tenantFindings };
}
