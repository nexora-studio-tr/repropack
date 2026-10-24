export interface PreviewResource { kind: 'keeper' | 'tunnel' | 'web'; name: string; id?: string }
export interface PreviewLease { owner: string; scope: string; engineId: string; appImage: string; tunnelImage: string; resources: PreviewResource[]; url?: string }
export function ownedPreviewId(value: Record<string, any>, lease: PreviewLease, resource: PreviewResource): string {
  const labels = value.Config?.Labels;
  if (!/^[a-f0-9-]{36}$/u.test(lease.owner) || !/^[a-f0-9]{64}$/u.test(lease.scope) || !/^[a-f0-9]{64}$/u.test(value.Id ?? '') ||
    value.Name !== `/${resource.name}` || (resource.id && value.Id !== resource.id) || labels?.['io.repropack.preview.owner'] !== lease.owner || labels?.['io.repropack.preview.scope'] !== lease.scope || labels?.['io.repropack.preview.kind'] !== resource.kind) throw new Error('Preview ownership mismatch; no container was removed');
  return value.Id as string;
}
export function requireDemoContainer(value: Record<string, any>, lease: PreviewLease, keeperId: string) {
  const env = new Map<string, string>((value.Config?.Env ?? []).map((entry: string) => { const split = entry.indexOf('='); return [entry.slice(0, split), entry.slice(split + 1)]; }));
  const host = value.HostConfig;
  if (!lease.url || !/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/u.test(lease.url) || value.Image !== lease.appImage || value.Config?.User !== '10001:10001' ||
    host?.NetworkMode !== `container:${keeperId}` || host.ReadonlyRootfs !== true || host.Privileged || !host.CapDrop?.includes('ALL') || host.CapAdd?.length || !host.SecurityOpt?.includes('no-new-privileges=true') || host.Binds?.length ||
    Object.keys(host.PortBindings ?? {}).length || value.Mounts?.some((mount: { Type: string; Destination: string }) => mount.Type !== 'tmpfs' || mount.Destination !== '/tmp') ||
    host.Memory !== 512 * 1024 ** 2 || host.MemorySwap !== host.Memory || host.NanoCpus !== 1e9 || host.PidsLimit !== 128 || env.get('REPROPACK_DEMO') !== '1' || env.get('REPROPACK_PUBLIC_ORIGIN') !== lease.url || env.get('REPROPACK_DATA_DIR') !== '' || env.has('REPROPACK_APP_CONFIG') || env.has('REPROPACK_APP_TEAM_ID') || env.get('REPROPACK_DEMO_LIFETIME_MS') !== '7200000') throw new Error('The public preview did not retain its isolated demo policy');
}
