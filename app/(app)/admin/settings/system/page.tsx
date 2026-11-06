import { listServiceActivity } from "@/lib/activity/query";
import { readServiceHealth } from "@/lib/dashboard/service";
import {
  listProviderMetrics,
  listProviderIdentityRates,
  listQueueByOrganization,
  listStuckLocks,
  readBodyLifecycleView,
  readInboundLifecycleView,
  readLoopLiveness,
  readUnconfirmedCluster,
} from "@/lib/system/read";
import { readStallLines } from "@/lib/domains/stall";
import { SystemScreen } from "./system-screen";

export const dynamic = "force-dynamic";

export default async function AdminSystemPage() {
  const [health, loops, stuckLocks, queueByOrganization, unconfirmed, providerIdentityRates, providerMetrics, serviceActivity, bodyLifecycle, inboundLifecycle, lines] = await Promise.all([
    readServiceHealth(),
    readLoopLiveness(),
    listStuckLocks(),
    listQueueByOrganization(),
    readUnconfirmedCluster(),
    listProviderIdentityRates(),
    listProviderMetrics(),
    listServiceActivity(null, 20),
    readBodyLifecycleView(),
    readInboundLifecycleView(),
    readStallLines(),
  ]);

  return (
    <SystemScreen
      health={health}
      loops={loops}
      stuckLocks={stuckLocks}
      queueByOrganization={queueByOrganization}
      unconfirmed={unconfirmed}
      providerIdentityRates={providerIdentityRates}
      providerMetrics={providerMetrics}
      serviceActivity={serviceActivity.rows}
      bodyLifecycle={bodyLifecycle}
      inboundLifecycle={inboundLifecycle}
      lines={lines}
    />
  );
}
