import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, LoaderCircle, Plus } from "lucide-react";
import { workspaceApi, type PluginAccount, type PluginServer } from "@/api";
import { ProviderMark } from "@/components/ProviderMark";
import { Button } from "@/components/ui/button";
import "./ApplicationAccess.css";

type AccountTilesProps = {
  accounts: PluginAccount[];
  catalog?: PluginServer[];
  selectedIds: ReadonlySet<string>;
  disabled?: boolean;
  pendingId?: string | null;
  onToggle: (accountId: string) => void;
};

type ProviderGroup = { key: string; name: string; provider?: string; accounts: PluginAccount[] };

function titleCase(value: string) {
  return value.replace(/[._/-]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

function groupAccounts(accounts: PluginAccount[], catalog: PluginServer[] = []): ProviderGroup[] {
  const servers = new Map(catalog.map(server => [server.id, server]));
  const groups = new Map<string, ProviderGroup>();
  for (const account of accounts) {
    const server = account.serverId ? servers.get(account.serverId) : undefined;
    const provider = account.provider ?? server?.provider ?? undefined;
    const key = provider ?? account.serverId ?? account.label;
    const group = groups.get(key) ?? { key, provider, name: server?.name ?? titleCase(provider ?? account.serverId ?? account.label), accounts: [] };
    group.accounts.push(account);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function AccountTiles({ accounts, catalog = [], selectedIds, disabled = false, pendingId, onToggle }: AccountTilesProps) {
  const labelPrefix=useId();
  return <div className="account-tiles">{groupAccounts(accounts, catalog).map(group => {
    const selectedCount = group.accounts.filter(account => selectedIds.has(account.id)).length;
    const labelId=`${labelPrefix}-${group.key.replace(/[^a-z0-9_-]/gi,"-")}`;
    return <section className={`account-tile${selectedCount ? " account-tile--granted" : ""}`} key={group.key} aria-labelledby={labelId}>
      <header><ProviderMark provider={group.provider} name={group.name}/><h3 id={labelId}>{group.name}</h3><span>{selectedCount} of {group.accounts.length}</span></header>
      <div className="account-tile-accounts">{group.accounts.map(account => {
        const checked = selectedIds.has(account.id);
        return <label key={account.id} className={checked ? "account-grant account-grant--selected" : "account-grant"}>
          <input type="checkbox" checked={checked} disabled={disabled} onChange={() => onToggle(account.id)}/>
          <span className="account-grant-check" aria-hidden="true">{pendingId === account.id ? <LoaderCircle className="spin"/> : checked ? <Check/> : null}</span>
          <span title={account.label}>{account.label}</span>
        </label>;
      })}</div>
    </section>;
  })}</div>;
}

export function ApplicationAccess({ companionId, onConnect }: { companionId: string; onConnect?: () => void }) {
  const [accounts, setAccounts] = useState<PluginAccount[]>([]);
  const [catalog, setCatalog] = useState<PluginServer[]>([]);
  const [selected, setSelected] = useState<PluginAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const mutationPending = useRef(false);
  const operation = useRef(0);

  const load = useCallback(async (generation: number) => {
    const [plugins, granted] = await Promise.all([workspaceApi.plugins(), workspaceApi.companionPlugins(companionId)]);
    if (operation.current !== generation) return;
    setAccounts(plugins.accounts); setCatalog(plugins.catalog); setSelected(granted.accounts);
  }, [companionId]);

  const reload = useCallback(async () => {
    const generation = ++operation.current;
    setLoading(true); setError("");
    try { await load(generation); }
    catch (cause) { if (operation.current === generation) setError(cause instanceof Error ? cause.message : "Could not load applications."); }
    finally { if (operation.current === generation) setLoading(false); }
  }, [load]);

  useEffect(() => {
    mutationPending.current = false;
    setPendingId(null);
    void reload();
    return () => { operation.current += 1; };
  }, [reload]);

  const selectedIds = new Set(selected.map(account => account.id));
  const grantedCount=accounts.filter(account=>selectedIds.has(account.id)).length;
  async function toggle(accountId: string) {
    if (mutationPending.current) return;
    mutationPending.current = true;
    const generation = ++operation.current;
    setPendingId(accountId); setError("");
    let mutationError = "";
    try {
      await (selectedIds.has(accountId) ? workspaceApi.unselectPlugin(companionId, accountId) : workspaceApi.selectPlugin(companionId, accountId));
    } catch (cause) {
      mutationError = cause instanceof Error ? cause.message : "Could not update this account.";
    }
    if (operation.current !== generation) return;
    try { await load(generation); }
    catch (cause) { if (!mutationError) mutationError = cause instanceof Error ? cause.message : "Could not reload applications."; }
    if (operation.current !== generation) return;
    setError(mutationError); setPendingId(null); mutationPending.current = false;
  }

  if (loading) return <div className="application-access-loading" role="status" aria-label="Loading applications"><span/><span/><span/></div>;
  if (!accounts.length && error) return <div className="application-access-state" role="alert"><p>{error}</p><Button variant="outline" onClick={() => void reload()}>Try again</Button></div>;
  if (!accounts.length) return <div className="application-access-state"><p>Connect an account to choose what this companion can use.</p>{onConnect && <Button variant="outline" onClick={onConnect}><Plus/>Connect an account</Button>}</div>;

  return <div className="application-access">
    <div className="application-access-meta"><span>{grantedCount} of {accounts.length} accounts granted</span>{onConnect && <button type="button" onClick={onConnect}>Manage connections</button>}</div>
    <AccountTiles accounts={accounts} catalog={catalog} selectedIds={selectedIds} disabled={pendingId !== null} pendingId={pendingId} onToggle={accountId => void toggle(accountId)}/>
    {error && <div className="application-access-error" role="alert"><span>{error}</span><Button size="sm" variant="outline" onClick={() => void reload()}>Reload</Button></div>}
  </div>;
}
