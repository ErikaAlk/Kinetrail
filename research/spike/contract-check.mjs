import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
const contract=JSON.parse(await readFile('../mcp-schemas.json','utf8'));
const ajv=new Ajv2020({strict:false,allErrors:true}); addFormats(ajv);
const validators=new Map();
for(const tool of contract.tools){
  assert.deepEqual(tool.securitySchemes,tool._meta.securitySchemes);
  const pair={};
  for(const name of ['inputSchema','outputSchema']) pair[name]=ajv.compile({$defs:contract.$defs,...tool[name]});
  validators.set(tool.name,pair);
}
const write={session_id:'synthetic-session',expected_revision:2,idempotency_key:'fixture-uuid-key-123',occurred_at:'2026-09-14T18:20:00+08:00',timezone:'Asia/Shanghai',raw_text:'我已完成高位下拉45kg，12次',completion:'completed',entries:[{exercise_name_raw:'高位下拉',category:'strength',sets:[{load_value:45,load_unit:'kg',reps:12}]}]};
const record=validators.get('record_workout_event').inputSchema;
assert.ok(record(write),JSON.stringify(record.errors));
assert.equal(record({...write,completion:'planned'}),false);
assert.equal(record({...write,owner_id:'other'}),false);
assert.equal(record({...write,idempotency_key:'tiny'}),false);
assert.equal(record({...write,entries:[{exercise_name_raw:'高位下拉',category:'strength',sets:[{reps:-1}]}]}),false);
assert.equal(validators.get('get_latest_measurement_full').inputSchema({refresh_if_stale:true}),false);
assert.equal(validators.get('get_raw_dataset').inputSchema({dataset:'account',start:write.occurred_at,end:write.occurred_at}),false);
for(const tool of contract.tools){
  if(tool.name==='refresh_data'||tool.name.includes('workout')&&!tool.name.startsWith('get_')) assert.equal(tool.annotations.readOnlyHint,false);
}
const result={schema_version:'1',request_id:'synthetic-request',status:'ok',data:{session_id:'synthetic-session',event_id:'synthetic-event',entry_ids:['synthetic-entry'],revision:3,committed_at:write.occurred_at,idempotency_key:write.idempotency_key},error:null,stale:false,synced_at:null,next_cursor:null,persistence:'committed'};
assert.ok(validators.get('record_workout_event').outputSchema(result));
const broken=structuredClone(result);delete broken.data.event_id;
assert.equal(validators.get('record_workout_event').outputSchema(broken),false);
const special={...write,entries:[{exercise_name_raw:'辅助引体',category:'strength',sets:[{load_original:{value:-20,unit:'器械格'},assistance_value:20,assistance_unit:'kg',reps:8}]}]};
assert.ok(record(special));
const validateDef=name=>ajv.compile({$defs:contract.$defs,...contract.$defs[name]});
assert.ok(validateDef('Error')({code:'REVISION_CONFLICT',message:'版本冲突',retryable:false,persistence:'not_committed',current_revision:4}));
assert.ok(validateDef('Session')({session_id:'fixture-session',status:'finalized',revision:4,started_at:write.occurred_at,ended_at:write.occurred_at,timezone:'Asia/Shanghai',facility:null,selection_required:false,duration_seconds:3600,duration_source:'user_reported',overall_rpe:8,notes:'合成总结'}));
assert.ok(validateDef('StoredEntry')({...special.entries[0],normalization_version:'1',normalized_sets:[{load_kg:null,assistance_kg:20,distance_m:null,speed_mps:null,quality_flags:['unknown_load_unit']}]}));
const report={tools:contract.tools.length,compiled_input_output_schemas:contract.tools.length*2,negative_cases:['planned','owner injection','short idempotency key','negative reps','read implicit refresh','account dataset','missing receipt event id'],review_regressions:['session summary','unknown unit and assistance','normalized output','current revision'],runtime_semantics:'schema-only; production cross-field checks remain required'};
await writeFile('../contract-results.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
