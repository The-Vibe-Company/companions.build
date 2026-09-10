import { resolve } from 'node:path';
const name=`companions-plugin-test-${crypto.randomUUID()}`;
const label=`companions.build.verification=${process.env.COMPANIONS_VERIFY_RUN??name}`;
async function command(args:string[]){const child=Bun.spawn(args,{stdout:'inherit',stderr:'inherit'});return child.exited;}
try{
  const code=await command(['docker','run','--rm','--init','--name',name,'--label',label,'--network','none','--platform','linux/amd64','--mount',`type=bind,src=${resolve('.')},dst=/repo,readonly`,'--mount',`type=bind,src=${process.execPath},dst=/usr/local/bin/bun,readonly`,'--workdir','/repo','--env','RUN_PLUGIN_STDIO_TESTS=1','debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171','bun','--no-env-file','test','packages/plugins/stdio.test.ts']);
  if(code)throw Error('PLUGIN_LINUX_TEST_FAILED');
}finally{
  const inspect=Bun.spawn(['docker','inspect','--format','{{.State.Running}}',name],{stdout:'pipe',stderr:'ignore'});
  if(await inspect.exited===0){await command(['docker','rm','-f',name]);throw Error('PLUGIN_LINUX_CLEANUP_REQUIRED');}
}
