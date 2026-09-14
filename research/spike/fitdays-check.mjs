import assert from 'node:assert/strict';
import { FitDaysClient, parseSyncFromServerData, md5Hex, newRequestId } from 'fitdays-api';
import { readFile } from 'node:fs/promises';

export const fixture = JSON.parse(await readFile(new URL('../../sanitized-fixtures/synthetic-cn-sync.json', import.meta.url), 'utf8'));
const datasets = ['weight_list','impedance_list','hr_list','balance_list','gravity_list','height_list','rulers_list','skip_list'];
const forbidden = /^(account|token|refresh_?token|access_?token|password|email|phone|mobile|openid|open_id|authorization|cookie|mac|sn|wifi_ext_data)$/i;
// 保守拒绝：只用于合成数据实验。真实未知字段分类、字符串内秘密识别另设 gate。
export function scan(value) {
  if (typeof value === 'string') {
    assert.ok(!/Bearer\s|https?:\/\/[^\s]*[?&](token|sign)=|[^\s@]+@[^\s@]+\.[^\s@]+/i.test(value), 'SENSITIVE_VALUE');
    if (/^[\s]*[\[{]/.test(value)) {
      let parsed; try { parsed = JSON.parse(value); } catch { return; }
      scan(parsed);
    }
  } else if (value && typeof value === 'object') {
    for (const [key,item] of Object.entries(value)) {
      assert.ok(!forbidden.test(key), 'SENSITIVE_KEY');
      scan(item);
    }
  }
}
export function selectMeasurements(response) {
  const selected = Object.fromEntries(datasets.filter(k => Object.hasOwn(response.data,k)).map(k=>[k,response.data[k]]));
  scan(selected);
  return selected;
}
export function guardedFetch(impl) {
  let calls = 0;
  return async (input, init) => {
    const url = new URL(input);
    if (url.origin !== 'https://online.fitdays.cn' || !['/api/users/login','/api/sync/syncFromServer'].includes(url.pathname)) throw new Error('UPSTREAM_ROUTE_DENIED');
    if (++calls > 3) throw new Error('REDIRECT_LIMIT');
    const response = await impl(input, {...init, redirect:'manual'});
    if (response.status >= 300 && response.status < 400) throw new Error('HTTP_REDIRECT_REQUIRES_REVIEW');
    return response;
  };
}
export async function checkFitdays() {
  const numeric='{"future_number":9007199254740993,"tiny":1.2300e-20}';
  assert.notEqual(String(JSON.parse(numeric).future_number),'9007199254740993');
  assert.equal(JSON.stringify(JSON.parse(numeric,(_key,value,context)=>typeof value==='number'?JSON.rawJSON(context.source):value)),numeric);
  assert.equal(md5Hex('abc'),'900150983cd24fb0d6963f7d28e17f72');
  assert.match(newRequestId(),/^[a-f0-9]{32}$/);
  const client = new FitDaysClient({region:'cn',fetchImpl:guardedFetch(async (_url,init)=>{
    assert.deepEqual(JSON.parse(init.body),{start_time:100,end_time:0});
    return Response.json(fixture);
  })});
  const response = await client.request('api/sync/syncFromServer',{start_time:100,end_time:0});
  const raw = selectMeasurements(response);
  assert.equal(raw.hr_list,null);
  assert.equal(Object.hasOwn(raw,'height_list'),false);
  assert.deepEqual(raw.rulers_list,[]);
  assert.deepEqual(raw.weight_list[0].unknown_measurement,{sample:[1,null,3]});
  assert.equal(raw.weight_list[0].ext_data,fixture.data.weight_list[0].ext_data);
  assert.throws(()=>parseSyncFromServerData(fixture.data),SyntaxError);
  const valid = structuredClone(fixture.data); valid.weight_list=[];
  assert.deepEqual(parseSyncFromServerData(valid).hr_list,[]);
  assert.equal(raw.impedance_list.find(r=>r.data_id===raw.weight_list[0].imp_data_id).impedance,500);
  for (const key of ['token','refresh_token','email','phone','password']) assert.throws(()=>scan({unknown:{[key]:'synthetic'}}),/SENSITIVE_KEY/);
  assert.throws(()=>scan({ext_data:JSON.stringify({nested:{token:'synthetic'}})}),/SENSITIVE_KEY/);
  // 复现上游 code:302 风险；第二跳在网络发送之前拒绝。
  let networkCalls = 0;
  const redirectClient=new FitDaysClient({region:'cn',fetchImpl:guardedFetch(async()=>{
    networkCalls++; return Response.json({code:302,data:{domain:'https://not-allowed.invalid'}});
  })});
  await assert.rejects(()=>redirectClient.request('api/sync/syncFromServer',{}),/UPSTREAM_ROUTE_DENIED/);
  assert.equal(networkCalls,1);
  const loopClient=new FitDaysClient({region:'cn',fetchImpl:guardedFetch(async()=>Response.json({code:302,data:{domain:'https://online.fitdays.cn'}}))});
  await assert.rejects(()=>loopClient.request('api/sync/syncFromServer',{}),/REDIRECT_LIMIT/);
  const counts=Object.fromEntries(datasets.map(k=>[k, !Object.hasOwn(raw,k)?'missing':raw[k]===null?'null':raw[k].length]));
  return {runtime:process.version,counts,fixture_bytes:Buffer.byteLength(JSON.stringify(fixture)),max_record_bytes:Math.max(...raw.weight_list.map(r=>Buffer.byteLength(JSON.stringify(r))))};
}
if (process.argv[1]?.endsWith('fitdays-check.mjs')) console.log(JSON.stringify(await checkFitdays()));
