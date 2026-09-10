import type {BoxClient} from '../../../packages/box/client';
import {userSystemctl} from '../../../packages/box/layout';
import type {SpecialistMachines} from './specialist-runtime';

const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
/** Operates only on the new copied workspace, never the source Companion. */
const sanitizeCopiedMemory = `
def sanitize_copied_memory(workspace,source_state=None):
    import json,sqlite3,datetime
    legacy=workspace/'MEMORY.md'
    if legacy.is_symlink() or legacy.is_file(): legacy.unlink()
    elif legacy.exists(): shutil.rmtree(legacy)
    export=workspace/'template-memory.json'
    if export.is_symlink(): export.unlink(); return
    if export.exists() and not export.is_file(): shutil.rmtree(export); return
    try:
        database=source_state/'memory'/'memory.sqlite' if source_state else None
        if database and (database.exists() or database.is_symlink()):
            # A best-effort export can lag a committed revocation. The frozen durable source wins.
            if database.parent.is_symlink() or database.is_symlink() or not database.is_file(): raise ValueError()
            for suffix in ('-wal','-shm'):
                sidecar=pathlib.Path(str(database)+suffix)
                if sidecar.is_symlink(): raise ValueError()
            connection=sqlite3.connect(database.as_uri()+'?mode=ro')
            try:
                now=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
                rows=connection.execute('SELECT content,scope,kind,project_key,provenance,reusable,expires_at FROM memories WHERE reusable=1 AND (expires_at IS NULL OR expires_at>?) ORDER BY updated_at DESC,id LIMIT 200',(now,)).fetchall()
                data={'version':1,'memories':[dict(zip(('content','scope','kind','projectKey','provenance','reusable','expiresAt'),row)) for row in rows]}
                for item in data['memories']: item['reusable']=item['reusable']==1
            finally: connection.close()
        else:
            if not export.exists(): return
            if export.stat().st_size>65536: raise ValueError()
            data=json.loads(export.read_text())
        if data.get('version')!=1 or not isinstance(data.get('memories'),list): raise ValueError()
        kept=[]
        for item in data['memories']:
            if not isinstance(item,dict) or item.get('reusable') is not True: continue
            scope,kind=item.get('scope'),item.get('kind')
            if not ((scope=='project' and kind in ('fact','procedure')) or (scope=='companion' and kind=='procedure')): continue
            content=item.get('content')
            if not isinstance(content,str) or not 0<len(content.encode('utf-8'))<=8000: continue
            if scope=='project' and not isinstance(item.get('projectKey'),str): continue
            expiry=item.get('expiresAt')
            if expiry is not None:
                if not isinstance(expiry,str): continue
                try:
                    expires=datetime.datetime.fromisoformat(expiry.replace('Z','+00:00'))
                    if expires.tzinfo is None or expires<=datetime.datetime.now(datetime.timezone.utc): continue
                except ValueError: continue
            candidate={key:item[key] for key in ('content','scope','kind','projectKey','provenance','reusable','expiresAt') if key in item and item[key] is not None}
            if len(json.dumps({'version':1,'memories':kept+[candidate]}).encode('utf-8'))<=65536: kept.append(candidate)
        export.write_text(json.dumps({'version':1,'memories':kept}))
        export.chmod(0o600)
    except (ValueError,OSError,TypeError,sqlite3.Error):
        export.unlink(missing_ok=True)
`;
/** Detect provider capture policies without exposing their paths or contents. */
export function specialistCapturePolicyInspection(){
 return `import os,pathlib
home=pathlib.Path('/home/user')
skip={'node_modules','.next','target','vendor'}
active=False
for root,dirs,files in os.walk(home,topdown=True,followlinks=False):
    current=pathlib.Path(root)
    try: depth=len(current.relative_to(home).parts)
    except ValueError: active=True; break
    dirs[:]=[] if depth>=6 else [name for name in dirs if name not in skip and not (current/name).is_symlink()]
    for name in ('.boxignore','.oneignore'):
        if name not in files: continue
        policy=current/name
        try:
            if policy.stat().st_size>262144: active=True; break
            with policy.open('r',encoding='utf-8') as handle:
                if any(line.strip() and not line.startswith('#') for line in handle): active=True; break
        except (OSError,UnicodeError): active=True; break
    if active: break
print('capture_policy_requires_review' if active else 'ok')
`;
}
/** Static product-owned paths only. User browser state and unrelated files are deliberately retained. */
export function specialistSanitization(sourceId:string){
 if(!/^[a-f0-9-]{36}$/.test(sourceId))throw Error('invalid_source_identity');
 return `import os, pathlib, shutil, pwd
${sanitizeCopiedMemory}
home=pathlib.Path('/home/user')
state=home/'.companions'
saved=home/'.specialist-skills'
workspace=home/'.specialist-workspace'
source=state/'agents'/'${sourceId}'
if not (source/'workspace').exists(): source=state
physical=pathlib.Path('/var/lib/companions-agent')
if physical.is_symlink(): raise RuntimeError('invalid_physical_state')
active=physical/'${sourceId}'
if active.is_symlink(): raise RuntimeError('invalid_physical_state')
if active.exists():
    if not active.is_dir() or not (active/'workspace').is_dir(): raise RuntimeError('invalid_physical_state')
    source=active
if workspace.is_symlink(): raise RuntimeError('invalid_workspace_destination')
if (source/'workspace').exists():
    if workspace.exists(): shutil.rmtree(workspace)
    shutil.copytree(source/'workspace',workspace,symlinks=True)
    sanitize_copied_memory(workspace,source)
if saved.is_symlink(): raise RuntimeError('invalid_skill_destination')
skills=source/'pi'/'skills'
if skills.exists():
    if saved.exists(): shutil.rmtree(saved)
    shutil.copytree(skills,saved,symlinks=True)
for path in [state,home/'.companions.env',pathlib.Path('/etc/companions-desktop.env'),pathlib.Path('/var/lib/companions-desktop')]:
    if path.is_symlink() or path.is_file(): path.unlink()
    elif path.exists(): shutil.rmtree(path)
# These paths belong to this captured image. Retain installed root directories, clear copied identities.
for parent in [physical,pathlib.Path('/var/lib/companions-runtime-migrations')]:
    if parent.is_symlink(): parent.unlink(); continue
    if parent.exists():
        for path in parent.iterdir():
            if path.is_symlink() or path.is_file(): path.unlink()
            elif path.is_dir(): shutil.rmtree(path)
user=pwd.getpwnam('user')
for retained in [saved,workspace]:
 if retained.exists():
    for root,dirs,files in os.walk(retained,followlinks=False):
        os.chown(root,user.pw_uid,user.pw_gid)
        for name in dirs+files: os.chown(pathlib.Path(root)/name,user.pw_uid,user.pw_gid,follow_symlinks=False)
`;
}
export function specialistBoxMachines(box:BoxClient|null):Pick<SpecialistMachines,'freezeSpecialist'|'createSpecialistImage'|'sanitizeSpecialistImage'>{
 return {
  async freezeSpecialist(companion,beforeEffect=async()=>{}){
   if(!box)throw Error('box_not_configured');
   await beforeEffect();
   const policy=(await box.command(companion.box_id,`sudo -n python3 -c ${quote(specialistCapturePolicyInspection())}`,30)).trim();
   if(policy!=='ok')throw Error('capture_policy_requires_review');
   // Disable before taking the private source capture: image copies cannot boot the old identity.
   await beforeEffect();
   await box.command(companion.box_id,`if test -f /opt/companions/desktop-boundary.version; then sudo -n systemctl disable --now companions-agent-proxy.socket companions-agent.service companions-desktop.service; else ${userSystemctl('disable --now companions-agent.service')}; fi`);
  },
  async createSpecialistImage(companion,checkpoint,beforeEffect=async()=>{}){
   if(!box)throw Error('box_not_configured');
   if(!companion.box_id&&companion.create_started_at&&Date.now()-new Date(companion.create_started_at).getTime()>23*3600_000)throw Error('image_creation_needs_reconciliation');
   if(!companion.box_id){await beforeEffect();const created=await box.create(companion.create_key,companion.snapshot_name);await checkpoint(created.id);companion.box_id=created.id;}
   const state=await box.get(companion.box_id);
   if(state.setupStatus==='failed')throw Error('image_preparation_failed');
   return ['ready','idle','running'].includes(state.state)&&(!state.setupStatus||state.setupStatus==='done');
  },
  async sanitizeSpecialistImage(companion,sourceId,beforeEffect=async()=>{}){
   if(!box)throw Error('box_not_configured');
   await beforeEffect();
   await box.command(companion.box_id,`sudo -n python3 -c ${quote(specialistSanitization(sourceId))}`,120);
  },
};
}

export function restoreSpecialistWorkspace(stateDir:string){
 if(!/^\/home\/user\/\.companions(?:\/agents\/[a-f0-9-]{36})?$/.test(stateDir))throw Error('invalid_agent_state');
 const script=`import os,pathlib,shutil,pwd
${sanitizeCopiedMemory}
state=pathlib.Path('${stateDir}')
created=[]
for source,target in [(pathlib.Path('/home/user/.specialist-workspace'),state/'workspace'),(pathlib.Path('/home/user/.specialist-skills'),state/'pi'/'skills')]:
    if source.exists() and not target.exists():
        target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copytree(source,target,symlinks=True)
        if target.name=='workspace': sanitize_copied_memory(target)
        created.append(target)
user=pwd.getpwnam('user')
for target in created:
    for root,dirs,files in os.walk(target,followlinks=False):
        os.chown(root,user.pw_uid,user.pw_gid)
        for name in dirs+files: os.chown(pathlib.Path(root)/name,user.pw_uid,user.pw_gid,follow_symlinks=False)
`;
 return `sudo -n python3 -c ${quote(script)}`;
}
