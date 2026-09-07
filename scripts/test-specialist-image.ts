import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {restoreSpecialistWorkspace,specialistCapturePolicyInspection,specialistSanitization} from '../apps/server/src/specialist-box';

const sourceId='11111111-1111-4111-8111-111111111111';
const directory=mkdtempSync(join(tmpdir(),'companions-specialist-image-'));
const container=`companions-specialist-image-${crypto.randomUUID()}`;
const image=process.env.SPECIALIST_TEST_IMAGE??'python:3.12-slim';

writeFileSync(join(directory,'sanitize.py'),specialistSanitization(sourceId),{mode:0o444});
writeFileSync(join(directory,'inspect-policy.py'),specialistCapturePolicyInspection(),{mode:0o444});
writeFileSync(join(directory,'restore.sh'),`#!/bin/sh\nset -eu\n${restoreSpecialistWorkspace('/home/user/.companions').replace(/^sudo -n /,'')}\n`,{mode:0o555});
writeFileSync(join(directory,'restore-child.sh'),`#!/bin/sh\nset -eu\n${restoreSpecialistWorkspace(`/home/user/.companions/agents/${sourceId}`).replace(/^sudo -n /,'')}\n`,{mode:0o555});
writeFileSync(join(directory,'scenario.py'),String.raw`import os, pathlib, subprocess, sys

home=pathlib.Path('/home/user')
state=home/'.companions'

if not any(line.startswith('user:') for line in pathlib.Path('/etc/passwd').read_text().splitlines()):
    with pathlib.Path('/etc/passwd').open('a') as handle:
        handle.write('user:x:1000:1000:Companion:/home/user:/bin/sh\n')
    with pathlib.Path('/etc/group').open('a') as handle:
        handle.write('user:x:1000:\n')

def put(path,content):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(content)

def policy_result():
    return subprocess.run([sys.executable,'/test/inspect-policy.py'],check=True,capture_output=True,text=True).stdout.strip()

# Git ignores do not affect Box capture. Empty/comment-only policies and skipped build trees are safe.
put(home/'.gitignore','*.secret\n')
put(home/'.boxignore','# reviewed: no active rules\n\n')
put(home/'projects'/'app'/'.oneignore','# comment\n')
put(home/'projects'/'app'/'node_modules'/'.boxignore','*\n')
assert policy_result() == 'ok'
put(home/'projects'/'app'/'.boxignore','dist/\n')
assert policy_result() == 'capture_policy_requires_review'
(home/'projects'/'app'/'.boxignore').unlink()
put(home/'projects'/'app'/'.oneignore','!dist/required.bin\n')
assert policy_result() == 'capture_policy_requires_review'
(home/'projects'/'app'/'.oneignore').write_text('# reviewed\n')
assert policy_result() == 'ok'
put(home/'projects'/'app'/'.boxignore','   # this is a pattern, not a comment\n')
assert policy_result() == 'capture_policy_requires_review'
(home/'projects'/'app'/'.boxignore').unlink()

put(state/'workspace'/'src'/'main.ts','export const answer = 42;\n')
put(state/'workspace'/'package-lock.json','{"dependencies":{"fixture":"1.0.0"}}\n')
put(state/'workspace'/'.git'/'config','[remote "origin"]\n\turl = https://github.com/acme/private.git\n')
os.symlink('src/main.ts',state/'workspace'/'latest.ts')
put(state/'pi'/'skills'/'reviewer'/'SKILL.md','# Reviewer\n')
put(state/'sessions'/'private.jsonl','model transcript\n')
put(state/'runs.sqlite','runtime history\n')
put(state/'identity.json','source companion identity\n')
put(state/'agent-token','agent-secret\n')
put(home/'.companions.env','AGENT_TOKEN=agent-secret\n')
put(pathlib.Path('/etc/companions-desktop.env'),'DESKTOP_IDENTITY=source\n')
put(pathlib.Path('/var/lib/companions-desktop/session'),'desktop runtime identity\n')
put(home/'.config/chromium/Default/Cookies','retained browser session\n')
put(home/'Documents/notes.txt','retained unrelated file\n')

for _ in range(2):
    subprocess.run([sys.executable,'/test/sanitize.py'],check=True)

saved_workspace=home/'.specialist-workspace'
saved_skills=home/'.specialist-skills'
assert not state.exists()
assert not (home/'.companions.env').exists()
assert not pathlib.Path('/etc/companions-desktop.env').exists()
assert not pathlib.Path('/var/lib/companions-desktop').exists()
assert (saved_workspace/'src'/'main.ts').read_text() == 'export const answer = 42;\n'
assert 'fixture' in (saved_workspace/'package-lock.json').read_text()
assert 'https://github.com/acme/private.git' in (saved_workspace/'.git'/'config').read_text()
assert (saved_workspace/'latest.ts').is_symlink()
assert (saved_skills/'reviewer'/'SKILL.md').read_text() == '# Reviewer\n'
assert (home/'.config/chromium/Default/Cookies').read_text() == 'retained browser session\n'
assert (home/'Documents/notes.txt').read_text() == 'retained unrelated file\n'
assert (saved_workspace/'src'/'main.ts').stat().st_uid == 1000
assert (saved_skills/'reviewer'/'SKILL.md').stat().st_uid == 1000

for _ in range(2):
    subprocess.run(['/bin/sh','/test/restore.sh'],check=True)

assert (state/'workspace'/'src'/'main.ts').read_text() == 'export const answer = 42;\n'
assert (state/'workspace'/'latest.ts').is_symlink()
assert (state/'pi'/'skills'/'reviewer'/'SKILL.md').read_text() == '# Reviewer\n'
assert (state/'workspace'/'src'/'main.ts').stat().st_uid == 1000
assert (state/'pi'/'skills'/'reviewer'/'SKILL.md').stat().st_uid == 1000
assert not (state/'sessions').exists()
assert not (state/'runs.sqlite').exists()
assert not (state/'identity.json').exists()
assert not (state/'agent-token').exists()
assert not (home/'.companions.env').exists()

# An exact child identity wins over unrelated root state when both exist.
import shutil
shutil.rmtree(state)
shutil.rmtree(saved_workspace)
shutil.rmtree(saved_skills)
put(state/'workspace'/'src'/'main.ts','decoy root source\n')
put(state/'pi'/'skills'/'reviewer'/'SKILL.md','decoy root skill\n')
child=state/'agents'/'${sourceId}'
put(child/'workspace'/'src'/'main.ts','selected child source\n')
put(child/'workspace'/'package-lock.json','{"dependencies":{"child":"2.0.0"}}\n')
put(child/'pi'/'skills'/'reviewer'/'SKILL.md','# Child reviewer\n')
put(child/'sessions'/'private.jsonl','child transcript\n')
for _ in range(2):
    subprocess.run([sys.executable,'/test/sanitize.py'],check=True)
assert (saved_workspace/'src'/'main.ts').read_text() == 'selected child source\n'
assert (saved_skills/'reviewer'/'SKILL.md').read_text() == '# Child reviewer\n'
for _ in range(2):
    subprocess.run(['/bin/sh','/test/restore-child.sh'],check=True)
restored_child=state/'agents'/'${sourceId}'
assert (restored_child/'workspace'/'src'/'main.ts').read_text() == 'selected child source\n'
assert (restored_child/'pi'/'skills'/'reviewer'/'SKILL.md').read_text() == '# Child reviewer\n'
assert (restored_child/'workspace'/'src'/'main.ts').stat().st_uid == 1000
assert (restored_child/'pi'/'skills'/'reviewer'/'SKILL.md').stat().st_uid == 1000
assert not (restored_child/'sessions').exists()
print('specialist image sanitization and restore verified')
`,{mode:0o444});

async function docker(args:string[],quiet=false){
 const child=Bun.spawn(['docker',...args],{stdout:quiet?'ignore':'inherit',stderr:quiet?'ignore':'inherit'});
 const code=await child.exited;if(code&&!quiet)throw Error(`docker_failed_${code}`);return code;
}

try{
 await docker(['run','--rm','--name',container,'--label','companions.build.test=specialist-image','--network','none','--mount',`type=bind,src=${directory},dst=/test,readonly`,image,'python3','/test/scenario.py']);
}finally{
 await docker(['rm','-f',container],true);
 rmSync(directory,{recursive:true,force:true});
}
