import { useEffect, useId, useRef, useState } from "react";
import { Ellipsis, Pencil, ShieldCheck, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PluginAccountNameForm } from "@/components/PluginAccountNameForm";
import "./ConnectionActions.css";

export function ConnectionActions({ label, providerName, busy, onCheck, onRename, onDisconnect }: {
  label: string;
  providerName: string;
  busy: boolean;
  onCheck?: () => void;
  onRename: (label: string) => Promise<boolean>;
  onDisconnect: () => void;
}) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const disclosure = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  function close(restoreFocus = false) {
    setOpen(false);
    setConfirming(false);
    setRenaming(false);
    if (restoreFocus) trigger.current?.focus();
  }
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !disclosure.current?.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => { if (confirming) keep.current?.focus(); }, [confirming]);
  return <details className="connection-actions" ref={disclosure} open={open}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close(); }}
    onKeyDown={event => { if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(true); } }}>
    <summary ref={trigger} role="button" tabIndex={0} aria-label={`Manage ${label}`} aria-expanded={open} aria-controls={panelId} aria-disabled={busy}
      onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (!event.repeat) event.currentTarget.click(); } }}
      onClick={event => { event.preventDefault(); if (!busy) { event.currentTarget.focus(); setOpen(!open); setConfirming(false); } }}><Ellipsis aria-hidden="true" /></summary>
    {open && <div id={panelId} className="connection-actions-panel">
      {renaming?<PluginAccountNameForm compact providerName={providerName} initialValue={label} busy={busy} submitLabel="Save name" onCancel={()=>{setRenaming(false);trigger.current?.focus();}} onSubmit={async value=>{if(await onRename(value))close(true);}}/>:confirming ? <div className="connection-actions-confirm" role="group" aria-label={`Disconnect ${label}?`}>
        <strong>Disconnect {label}?</strong>
        <p>Companions will lose access to this account.</p>
        <div><Button ref={keep} variant="ghost" size="sm" disabled={busy} onClick={() => { setConfirming(false); trigger.current?.focus(); }}>Keep connected</Button><Button variant="destructive" size="sm" disabled={busy} aria-label={`Confirm disconnect ${label}`} onClick={() => { close(true); onDisconnect(); }}>Disconnect</Button></div>
      </div> : <>
        <button type="button" disabled={busy} onClick={() => setRenaming(true)}><Pencil aria-hidden="true" />Rename account</button>
        {onCheck && <button type="button" disabled={busy} onClick={() => { close(true); onCheck(); }}><ShieldCheck aria-hidden="true" />Check connection</button>}
        <button type="button" disabled={busy} onClick={() => setConfirming(true)}><Unplug aria-hidden="true" />Disconnect</button>
      </>}
    </div>}
  </details>;
}
