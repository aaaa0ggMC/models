import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { adminApi, ApiRequestError, type ActionableError } from '../api/client.js';
import { computeModelAvailability } from '../api/model-availability.js';
import type {
  AccessPathDto,
  CapabilityMatrixEntry,
  EnvCredentialPathDto,
  MaskedCredential,
  ProviderConfig,
} from '../api/types.js';
import { RouteGraphCanvas } from '../components/RouteGraphCanvas.js';
import { ErrorBanner, PageHeader } from '../components/ui.js';

export function RoutingEnginePage(): React.JSX.Element {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [credentials, setCredentials] = useState<MaskedCredential[]>([]);
  const [envCredentials, setEnvCredentials] = useState<EnvCredentialPathDto[]>([]);
  const [accessPaths, setAccessPaths] = useState<AccessPathDto[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityMatrixEntry[]>([]);
  const [error, setError] = useState<ActionableError | null>(null);

  const loadMeta = useCallback(async () => {
    setError(null);
    try {
      const [pRes, cRes, eRes, apRes, capRes] = await Promise.all([
        adminApi.listProviders(),
        adminApi.listCredentials(),
        adminApi.listEnvCredentials().catch(() => ({ items: [] as EnvCredentialPathDto[] })),
        adminApi.listAccessPaths().catch(() => ({ items: [] as AccessPathDto[] })),
        adminApi.listCapabilities(),
      ]);
      setProviders(pRes.items);
      setCredentials(cRes.items);
      setEnvCredentials(eRes.items);
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
        credentials,
        envCredentials,
        accessPaths,
        capabilities,
      }),
    [providers, credentials, envCredentials, accessPaths, capabilities],
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
