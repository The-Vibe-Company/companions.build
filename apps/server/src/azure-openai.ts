export function normalizeAzureOpenAIBaseUrl(raw:string|undefined):string{
 if(!raw)throw Error('AZURE_OPENAI_BASE_URL_INVALID');
 let url:URL;try{url=new URL(raw.trim());}catch{throw Error('AZURE_OPENAI_BASE_URL_INVALID');}
 const host=url.hostname.toLowerCase();
 const azureHost=['.openai.azure.com','.cognitiveservices.azure.com','.services.ai.azure.com'].some(suffix=>host.endsWith(suffix)&&host.length>suffix.length);
 if(url.protocol!=='https:'||url.port||url.username||url.password||url.search||url.hash||!azureHost)throw Error('AZURE_OPENAI_BASE_URL_INVALID');
 let path=url.pathname.replace(/\/+$/,'');
 if(path.endsWith('/responses'))path=path.slice(0,-'/responses'.length);
 if(!path.endsWith('/openai/v1'))throw Error('AZURE_OPENAI_BASE_URL_INVALID');
 url.pathname=path;return url.toString().replace(/\/+$/,'');
}
