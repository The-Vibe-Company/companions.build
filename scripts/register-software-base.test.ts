import { expect, test } from "bun:test";
import { completedSnapshotJournal } from "./register-software-base";

test("software base registration accepts only a completed attempt after any quota rejection", () => {
  expect(completedSnapshotJournal({ snapshotRequestedAt: "2026-09-07T10:00:00.000Z", completedAt: "2026-09-07T10:01:00.000Z" })).toBe(true);
  expect(completedSnapshotJournal({ snapshotRejectedAt: "2026-09-07T09:00:00.000Z", snapshotRequestedAt: "2026-09-07T10:00:00.000Z", completedAt: "2026-09-07T10:01:00.000Z" })).toBe(true);
  expect(completedSnapshotJournal({ snapshotRejectedAt: "2026-09-07T10:00:30.000Z", snapshotRequestedAt: "2026-09-07T10:00:00.000Z", completedAt: "2026-09-07T10:01:00.000Z" })).toBe(false);
  expect(completedSnapshotJournal({ snapshotRequestedAt: "2026-09-07T10:00:00.000Z" })).toBe(false);
});

import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateSoftwareBaseArtifact} from './register-software-base';
import {AGENT_RELEASE_FILES,calculateAgentReleaseDigest} from './lib/agent-release';
import {canonicalJson,softwareDistributionDescriptorPayload} from '../packages/box/software-distribution';
import {distributionManifest,manifestDigest,saveDistributionJournal} from './lib/distribution-verification';

test('registration requires restored content proof and reads the immutable archive independently of dist/agent',async()=>{
 const root=await mkdtemp(join(tmpdir(),'companions-registration-')),directory=join(root,'release');
 try{
  await mkdir(directory);await mkdir(join(root,'.local','distributions'),{recursive:true});
  for(const path of AGENT_RELEASE_FILES)await writeFile(join(directory,path),'fixture-'+path);
  const builder=Buffer.from('builder'),keyring=Buffer.from('keyring');
  const config={version:1 as const,base:{id:'fixture-base',distro:{family:'ubuntu',suite:'noble',architecture:'amd64'}},aptRepository:{family:'ubuntu',snapshot:'20260901T000000Z',architecture:'amd64',keyringPath:'/opt/keyring.gpg',sources:[{origin:'https://snapshot.ubuntu.com/ubuntu/20260901T000000Z',suite:'noble',components:['main'],inReleaseSha256:'a'.repeat(64)}]},npmRegistry:'https://registry.npmjs.org'};
  const payload=softwareDistributionDescriptorPayload(config,keyring,builder),digest=calculateAgentReleaseDigest(directory,{builder,keyring,descriptorPayload:payload});
  const descriptor={...payload,base:{...payload.base,distributionDigest:digest}},descriptorBytes=canonicalJson(descriptor)+'\n';
  await writeFile(join(directory,'software-builder.json'),descriptorBytes);await writeFile(join(directory,'companion-software-builder'),builder);await writeFile(join(directory,'software-apt-keyring.gpg'),keyring);
  const manifest=await distributionManifest(directory),archive=join(root,'archive.tar.gz');
  const tar=Bun.spawnSync(['/usr/bin/tar','-czf',archive,'-C',directory,'.']);expect(tar.exitCode).toBe(0);
  const bytes=await readFile(archive),sha256=createHash('sha256').update(bytes).digest('hex');await writeFile(join(root,'.local','distributions',sha256+'.tar.gz'),bytes);
  const journal:any={version:1,name:'fixture-v12',key:crypto.randomUUID(),startedAt:'2026-09-07T10:00:00.000Z',boxId:'source-box',sha256,manifest,manifestDigest:manifestDigest(manifest),snapshotRequestedAt:'2026-09-07T10:01:00.000Z',completedAt:'2026-09-07T10:03:00.000Z',verification:{key:crypto.randomUUID(),startedAt:'2026-09-07T10:02:00.000Z',boxId:'verifier-box'},software:{baseId:descriptor.base.id,distributionDigest:digest,resolverConfigDigest:descriptor.resolverConfigDigest,descriptorSha256:createHash('sha256').update(descriptorBytes).digest('hex')}};
  const path=join(root,'.local','template-fixture-v12.json');await saveDistributionJournal(path,journal);
  await expect(validateSoftwareBaseArtifact('fixture-v12',root)).rejects.toThrow('Template journal is incomplete');
  journal.contentVerifiedAt='2026-09-07T10:03:00.000Z';await saveDistributionJournal(path,journal);
  // There deliberately is no dist/agent alias or mutable .local/agent.tar.gz.
  expect(await validateSoftwareBaseArtifact('fixture-v12',root)).toMatchObject({id:'fixture-base',providerSnapshotName:'fixture-v12',distributionDigest:digest});
  journal.manifest.files[0].sha256='0'.repeat(64);await saveDistributionJournal(path,journal);
  await expect(validateSoftwareBaseArtifact('fixture-v12',root)).rejects.toThrow('Template journal is incomplete');
 }finally{await rm(root,{recursive:true,force:true});}
});
