import { ArrowUp, CircleStop, FileText, LoaderCircle, Paperclip, Plus, X } from "lucide-react";
import { type DragEvent, type FormEvent, forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api, ApiError, isActiveRun, type CompanionDetail, type CompanionSkill } from "@/api";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { cn } from "@/lib/utils";
const MAX_CHAT_FILES = 5;
const MAX_CHAT_FILE_BYTES = 10 * 1024 * 1024;
const CHAT_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function PendingFile({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [image, setImage] = useState<{ file: File; url: string }>();
  const preview = image?.file === file ? image.url : undefined;
  useEffect(() => {
    if (!CHAT_IMAGE_TYPES.has(file.type)) return;
    const url = URL.createObjectURL(file);
    setImage({ file, url });
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return <span className={preview ? "pending-image" : undefined}>
    {preview ? <img src={preview} alt={`Preview of ${file.name}`} /> : <FileText />}
    <span className="pending-file-name">{file.name}</span>
    <button type="button" onClick={onRemove} aria-label={`Remove ${file.name}`}><X /></button>
  </span>;
}

export interface ChatComposerHandle { suggest(text: string): void }
export const ChatComposer = forwardRef<ChatComposerHandle, { detail: CompanionDetail; onRefresh: () => Promise<void>; onUnauthorized: () => void }>(function ChatComposer({ detail, onRefresh, onUnauthorized }, ref) {
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState("");
  const [fileNotice, setFileNotice] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [skills, setSkills] = useState<CompanionSkill[]>([]);
  const [skillCommandsEnabled, setSkillCommandsEnabled] = useState<boolean | null>(null);
  const [skillsUnavailable, setSkillsUnavailable] = useState(false);
  const [commandToken, setCommandToken] = useState<{ start: number; end: number; query: string } | null>(null);
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suppressCommandDetection = useRef(false);
  const dismissedSelection = useRef<{ value: string; start: number; end: number } | null>(null);
  const skillsCompanion = useRef<string | null>(null);
  const skillsRequest = useRef(0);
  const activeCommandStart = useRef<number | null>(null);
  const dragDepth = useRef(0);
  const activeRun = detail.runs.find((run) => run.lane !== "background" && isActiveRun(run.status));
  const visibleSkills = commandToken
    ? skills.filter(skill => skill.name.toLocaleLowerCase().includes(commandToken.query.toLocaleLowerCase().replace(/^skill:/, "")))
    : [];
  const paletteOpen = Boolean(commandToken && skillCommandsEnabled !== false);
  const activeSkill = visibleSkills[Math.min(activeSkillIndex, Math.max(visibleSkills.length - 1, 0))];

  useEffect(() => {
    if (!paletteOpen || !activeSkill) return;
    document.getElementById(`skill-option-${detail.companion.id}-${Math.min(activeSkillIndex, visibleSkills.length - 1)}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeSkill, activeSkillIndex, detail.companion.id, paletteOpen, visibleSkills.length]);

  useEffect(() => {
    skillsCompanion.current = null;
    skillsRequest.current += 1;
    activeCommandStart.current = null;
    dismissedSelection.current = null;
    setSkills([]);
    setSkillCommandsEnabled(null);
    setSkillsUnavailable(false);
  }, [detail.companion.id]);

  function discoverSkills() {
    const companionId = detail.companion.id;
    skillsCompanion.current = companionId;
    const request = ++skillsRequest.current;
    setSkills([]);
    setSkillsUnavailable(false);
    setSkillCommandsEnabled(null);
    void api.getCompanionSkills(companionId).then(result => {
      if (request !== skillsRequest.current || skillsCompanion.current !== companionId) return;
      setSkills(result.skills);
      setSkillCommandsEnabled(result.enabled);
    }).catch(() => {
      if (request !== skillsRequest.current || skillsCompanion.current !== companionId) return;
      setSkillsUnavailable(true);
      setSkillCommandsEnabled(true);
    });
  }

  function findCommandToken(value: string, caret: number | null) {
    if (caret == null) return null;
    const separator = /[\s,;!?()[\]{}<>"'`]/;
    let start = caret - 1;
    while (start >= 0 && !separator.test(value[start]) && value[start] !== "/") start -= 1;
    if (start < 0 || value[start] !== "/") return null;
    let end = caret;
    while (end < value.length && !separator.test(value[end])) end += 1;
    return { start, end, query: value.slice(start + 1, end) };
  }

  function updateCommandToken(value: string, caret: number | null) {
    const token = findCommandToken(value, caret);
    setCommandToken(token);
    if (token && activeCommandStart.current !== token.start) discoverSkills();
    activeCommandStart.current = token?.start ?? null;
    setActiveSkillIndex(0);
  }

  function insertSkill(skill: CompanionSkill) {
    if (!commandToken) return;
    const command = `/skill:${skill.name}`;
    const nextDraft = draft.slice(0, commandToken.start) + command + draft.slice(commandToken.end);
    const nextCaret = commandToken.start + command.length;
    setDraft(nextDraft);
    setCommandToken(null);
    activeCommandStart.current = null;
    suppressCommandDetection.current = true;
    dismissedSelection.current = { value: nextDraft, start: nextCaret, end: nextCaret };
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
      suppressCommandDetection.current = false;
    });
  }
  useImperativeHandle(ref, () => ({ suggest(text) { setDraft(text); textareaRef.current?.focus(); } }), []);
  async function send(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setActionError("");
    try {
      await api.sendMessage(detail.companion.id, content, files);
      setDraft("");
      setCommandToken(null);
      activeCommandStart.current = null;
      setFiles([]);
      setFileNotice("");
      await onRefresh();
      textareaRef.current?.focus();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
      else setActionError(cause instanceof Error ? cause.message : "Could not send message");
    } finally {
      setSending(false);
    }
  }

  function addFiles(incoming: File[]) {
    if (!incoming.length) return;
    if (files.length + incoming.length > MAX_CHAT_FILES) {
      setActionError(`A message accepts at most ${MAX_CHAT_FILES} files.`); setFileNotice(""); return;
    }
    if (incoming.some(file => file.size < 1 || file.size > MAX_CHAT_FILE_BYTES)) {
      setActionError("Each file must be between 1 byte and 10 MB."); setFileNotice(""); return;
    }
    setFiles(current => [...current, ...incoming]); setActionError("");
    setFileNotice(`${incoming.length} ${incoming.length === 1 ? "file" : "files"} attached.`);
  }

  function carriesFiles(event: DragEvent) { return Array.from(event.dataTransfer.types).includes("Files"); }
  function dragEnter(event: DragEvent<HTMLFormElement>) { if (!carriesFiles(event)) return; event.preventDefault(); dragDepth.current += 1; setDragActive(true); setFileNotice(`Drop up to ${MAX_CHAT_FILES} files here.`); }
  function dragOver(event: DragEvent<HTMLFormElement>) { if (!carriesFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }
  function dragLeave(event: DragEvent<HTMLFormElement>) { if (!dragDepth.current) return; event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) { setDragActive(false); setFileNotice(""); } }
  function drop(event: DragEvent<HTMLFormElement>) { if (!carriesFiles(event)) return; event.preventDefault(); dragDepth.current = 0; setDragActive(false); addFiles(Array.from(event.dataTransfer.files)); }

  async function cancel() {
    setActionError("");
    try {
      await api.cancel(detail.companion.id);
      await onRefresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not cancel work");
    }
  }

  return (
      <form className={cn("composer-wrap", dragActive && "composer-wrap--drop")} onSubmit={send} onDragEnter={dragEnter} onDragOver={dragOver} onDragLeave={dragLeave} onDrop={drop}>
        <span className="sr-only" aria-live="polite">{fileNotice}</span>
        {actionError && <p className="composer-error" role="alert">{actionError}</p>}
        {files.length > 0 && <div className="pending-files">{files.map((file, index) => <PendingFile key={index} file={file} onRemove={() => setFiles(current => current.filter((_, item) => item !== index))} />)}</div>}
        <div className="composer">
          {dragActive && <div className="drop-indicator" aria-hidden="true"><Paperclip />Drop files here</div>}
          {paletteOpen && <div className="skill-palette" role="listbox" id={`skill-palette-${detail.companion.id}`} aria-label="Skills">
            {skillCommandsEnabled == null ? <p role="status">Loading skills…</p>
              : skillsUnavailable ? <p>Skills are unavailable. You can still send your message.</p>
              : skills.length === 0 ? <p>No skills available.</p>
              : visibleSkills.length === 0 ? <p>No matching skills.</p>
              : visibleSkills.map((skill, index) => <button
                type="button"
                role="option"
                id={`skill-option-${detail.companion.id}-${index}`}
                aria-selected={index === activeSkillIndex}
                className={cn(index === activeSkillIndex && "skill-option--active")}
                key={skill.name}
                onMouseDown={event => event.preventDefault()}
                onMouseEnter={() => setActiveSkillIndex(index)}
                onClick={() => insertSkill(skill)}
              >
                <span><strong>/skill:{skill.name}</strong>{skill.source && <small>{skill.source}</small>}</span>
                {skill.description && <p>{skill.description}</p>}
              </button>)}
          </div>}
          <Textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => { dismissedSelection.current = null; setDraft(event.target.value); updateCommandToken(event.target.value, event.target.selectionStart); }}
            onClick={(event) => { dismissedSelection.current = null; updateCommandToken(event.currentTarget.value, event.currentTarget.selectionStart); }}
            onSelect={(event) => {
              if (suppressCommandDetection.current) return;
              const input = event.currentTarget, dismissed = dismissedSelection.current;
              // setSelectionRange queues a native select event after the animation frame.
              // Keep the inserted/dismissed token closed until the user edits or moves the caret.
              if (dismissed && dismissed.value === input.value && dismissed.start === input.selectionStart && dismissed.end === input.selectionEnd) return;
              dismissedSelection.current = null;
              updateCommandToken(input.value, input.selectionStart);
            }}
            onPaste={(event) => {
              const images = Array.from(event.clipboardData.items)
                .filter(item => item.kind === "file" && CHAT_IMAGE_TYPES.has(item.type))
                .map(item => item.getAsFile())
                .filter((file): file is File => file !== null);
              addFiles(images);
              // Keep native text insertion, including mixed text/image clipboard content.
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (paletteOpen && event.key === "Escape") {
                event.preventDefault();
                dismissedSelection.current = { value: event.currentTarget.value, start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd };
                setCommandToken(null);
                activeCommandStart.current = null;
                return;
              }
              if (paletteOpen && visibleSkills.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                event.preventDefault();
                setActiveSkillIndex(current => event.key === "ArrowDown"
                  ? (current + 1) % visibleSkills.length
                  : (current - 1 + visibleSkills.length) % visibleSkills.length);
                return;
              }
              if (paletteOpen && activeSkill && event.key === "Enter") {
                event.preventDefault();
                insertSkill(activeSkill);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={`Message ${detail.companion.name}`}
            aria-label={`Message ${detail.companion.name}`}
            aria-autocomplete="list"
            aria-expanded={paletteOpen}
            aria-controls={paletteOpen ? `skill-palette-${detail.companion.id}` : undefined}
            aria-activedescendant={paletteOpen && activeSkill ? `skill-option-${detail.companion.id}-${Math.min(activeSkillIndex, visibleSkills.length - 1)}` : undefined}
            rows={2}
          />
          <div className="composer-actions">
            <span className="composer-hint">Enter to send · Shift + Enter for a new line</span>
            <div className="composer-buttons">
              <label className="attach-button" aria-label="Attach files"><Plus /><input type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/csv,text/markdown,application/json,.md,.markdown,.txt,.csv,.json" onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} /></label>
              {(activeRun || (actionError && api.hasPendingUpload(detail.companion.id))) && (
                <Button type="button" variant="outline" size="sm" onClick={cancel}><CircleStop />Cancel</Button>
              )}
              <Button type="submit" size="icon" disabled={!draft.trim() || sending} aria-label="Send message">
                {sending ? <LoaderCircle className="spin" /> : <ArrowUp />}
              </Button>
            </div>
          </div>
        </div>
      </form>
  );
});
