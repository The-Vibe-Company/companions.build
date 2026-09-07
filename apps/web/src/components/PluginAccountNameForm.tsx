import { FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import "./PluginAccountNameForm.css";

export function PluginAccountNameForm({ providerName, initialValue = "", busy = false, compact = false, submitLabel, onCancel, onSubmit }: {
  providerName: string;
  initialValue?: string;
  busy?: boolean;
  compact?: boolean;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (label: string) => void | Promise<void>;
}) {
  const id=useId();
  const [value,setValue]=useState(initialValue);
  async function submit(event:FormEvent){event.preventDefault();const label=value.trim();if(label)await onSubmit(label);}
  return <form className={`plugin-account-name${compact?" plugin-account-name--compact":""}`} onSubmit={submit}>
    <div className="field"><label htmlFor={id}>Account name</label><input id={id} autoFocus maxLength={80} value={value} onChange={event=>setValue(event.target.value)} placeholder="Client workspace" aria-describedby={`${id}-help`} /></div>
    <p id={`${id}-help`}>{compact?`Rename this ${providerName} account.`:`Name this ${providerName} account so you can tell it apart from your other connections. You can also rename existing accounts from their menu.`}</p>
    <div><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>Cancel</Button><Button type="submit" size="sm" disabled={busy||!value.trim()}>{submitLabel}</Button></div>
  </form>;
}
