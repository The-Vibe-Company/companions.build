"""Sign in through Better Auth + the checkout's local Mailpit. Never prints the login token."""
import http.cookiejar
import json
import os
from pathlib import Path
import re
import time
import urllib.request
from urllib.parse import urlparse
ROOT=Path(__file__).resolve().parent.parent
values={}
for line in (ROOT/'.env').read_text().splitlines() if (ROOT/'.env').exists() else []:
 key,sep,value=line.partition('=')
 if sep: values[key.strip()]=value.strip().strip('\"\'')
port=int(os.environ.get('WEB_PORT',values.get('WEB_PORT',4310)))
base=f'http://127.0.0.1:{port}'
email=os.environ.get('LOCAL_DEV_EMAIL',values.get('LOCAL_DEV_EMAIL','developer@companions.build'))
request=urllib.request.Request(base+'/api/auth/sign-in/magic-link',data=json.dumps({'email':email,'callbackURL':'/'}).encode(),headers={'content-type':'application/json','origin':base})
with urllib.request.urlopen(request) as response:
 if response.status!=200:raise SystemExit('Sign-in email could not be requested')
mail=f'http://127.0.0.1:{port+6}'
for attempt in range(100):
 with urllib.request.urlopen(mail+'/api/v1/messages') as response: messages=json.load(response)['messages']
 matching=next((m for m in messages if any(v['Address']==email for v in m.get('To',[]))),None)
 if matching:
  with urllib.request.urlopen(mail+'/api/v1/message/'+matching['ID']) as response: message=json.load(response)
  links=re.findall(r'https?://\S+',message.get('Text',''))
  link=next((u for u in links if urlparse(u).netloc==f'127.0.0.1:{port}' and urlparse(u).path=='/api/auth/magic-link/verify'),None)
  if link:break
 time.sleep(.1)
else:raise SystemExit('Local sign-in email was not delivered')
jar=http.cookiejar.CookieJar();opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
with opener.open(link) as response: response.read()
cookie='; '.join(f'{c.name}={c.value}' for c in jar if c.name=='better-auth.session_token')
if not cookie:raise SystemExit('Local email verification did not establish a session')
path=ROOT/'.local/session-cookie';path.parent.mkdir(exist_ok=True);path.touch(mode=0o600,exist_ok=True);path.chmod(0o600);path.write_text(cookie)
print('Better Auth local session saved for authenticated canaries.')
