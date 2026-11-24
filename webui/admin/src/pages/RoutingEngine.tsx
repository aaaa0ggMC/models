import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { adminApi, ApiRequestError, type ActionableError } from '../api/client.js';
import { computeModelAvailability } from '../api/model-availability.js';
import type {
  AccessPathDto,
  CapabilityMatrixEntry,
  ProviderConfig,
} from '../api/types.js';
import { RouteGraphCanvas } from '../components/RouteGraphCanvas.js';
import { ErrorBanner, PageHeader } from '../components/ui.js';

export function RoutingEnginePage(): React.JSX.Element {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [accessPaths, setAccessPaths] = useState<AccessPathDto[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityMatrixEntry[]>([]);
  const [error, setError] = useState<ActionableError | null>(null);

  const loadMeta = useCallback(async () => {
    setError(null);
    try {
      const [pRes, apRes, capRes] = await Promise.all([
        adminApi.listProviders(),
        adminApi.listAccessPaths().catch(() => ({ items: [] as AccessPathDto[] })),
        adminApi.listCapabilities(),
      ]);
      setProviders(pRes.items);
      setAccessPaths(apRes.items);
      setCapabilities(capRes.items);
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '加载失败', message: err instanceof Error ? err.message : '加载失败' },
      );
    }
  }, []);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  const availability = useMemo(
    () =>
      computeModelAvailability({
        providers,
        accessPaths,
        capabilities,
      }),
    [providers, accessPaths, capabilities],
  );

  return (
    <div className="ag-page">
      <PageHeader title="路由引擎" helpSection="aliases" />
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      <RouteGraphCanvas
        providers={providers}
        accessPaths={accessPaths}
        modelOptions={availability.options}
      />
    </div>
  );
}
