"""生成可审查的 JSON Schema 契约，不生成服务实现。"""
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parent
def obj(props,required=()):
    return {'type':'object','properties':props,'required':list(required),'additionalProperties':False}
def ref(name): return {'$ref':'#/$defs/'+name}
def arr(item,maximum=200,minimum=0): return {'type':'array','items':item,'minItems':minimum,'maxItems':maximum}
def enum(*values): return {'enum':list(values)}
def string(maximum=256): return {'type':'string','minLength':1,'maxLength':maximum}
def number(minimum=0): return {'type':'number','minimum':minimum}
def integer(minimum=0): return {'type':'integer','minimum':minimum}
def nullable(schema): return {'anyOf':[schema,{'type':'null'}]}
ID=string(128); TEXT=string(4096); TIME={'type':'string','format':'date-time'}; BOOL={'type':'boolean'}
# 整场消耗热量（kcal）：手表汇总值，上限按一场训练的量级设，不承担医学口径。
KCAL={'type':'number','minimum':0,'maximum':20000}
defs={}
defs['Set']=obj({
    'load_original':obj({'value':{'anyOf':[{'type':'number'},string(80)]},'unit':string(40)},['value','unit']),
    'distance_original':obj({'value':{'anyOf':[{'type':'number'},string(80)]},'unit':string(40)},['value','unit']),
    'speed_original':obj({'value':{'anyOf':[{'type':'number'},string(80)]},'unit':string(40)},['value','unit']),
    'assistance_value':number(),'assistance_unit':enum('kg','lb'),
    'set_type':enum('warmup','working','drop','failure','other'),
    'load_value':number(),'load_unit':enum('kg','lb'),'load_basis':enum('total_external','per_hand','bodyweight','assisted','unknown'),
    'reps':integer(),'duration_seconds':integer(),'distance_value':number(),'distance_unit':enum('m','km','mi'),
    'speed':number(),'speed_unit':enum('m/s','km/h','mph'),'incline_pct':{'type':'number','minimum':-100,'maximum':100},
    'resistance':{'anyOf':[number(),string(80)]},'resistance_unit':string(40),'power_watts':number(),
    'rpe':{'type':'number','minimum':0,'maximum':10},'rir':number(),'heart_rate_avg':number(),'heart_rate_max':number(),
    'notes':TEXT
})
defs['Entry']=obj({'exercise_name_raw':string(120),'exercise_id':ID,'category':enum('strength','cardio','mobility','other'),
    'equipment_ref':ID,'equipment_label':string(120),'facility':string(120),'sets':arr(ref('Set'),100,1),'notes':TEXT},['exercise_name_raw','category','sets'])
defs['StoredEntry']=obj({**defs['Entry']['properties'],'normalization_version':ID,'normalized_sets':arr(obj({'load_kg':nullable(number()),'assistance_kg':nullable(number()),'distance_m':nullable(number()),'speed_mps':nullable(number()),'quality_flags':arr(ID)},['load_kg','assistance_kg','distance_m','speed_mps','quality_flags']),100,1)},['exercise_name_raw','category','sets','normalization_version','normalized_sets'])
defs['Receipt']=obj({'session_id':ID,'event_id':ID,'entry_ids':arr(ID,100),'revision':integer(1),'committed_at':TIME,'idempotency_key':ID},['session_id','event_id','entry_ids','revision','committed_at','idempotency_key'])
defs['Session']=obj({'session_id':ID,'status':enum('open','finalized'),'revision':integer(),'started_at':TIME,'ended_at':nullable(TIME),'timezone':string(80),'facility':nullable(string(120)),'selection_required':BOOL,'duration_seconds':nullable(integer()),'duration_source':enum('user_reported','timestamps','unknown'),'overall_rpe':nullable({'type':'number','minimum':0,'maximum':10}),'calories_kcal':nullable(KCAL),'notes':nullable(TEXT)},['session_id','status','revision','started_at','ended_at','timezone','facility','selection_required','duration_seconds','duration_source','overall_rpe','calories_kcal','notes'])
defs['Workout']=obj({'session':ref('Session'),'entries':arr(obj({'entry_id':ID,'version':integer(1),'supersedes_version':nullable(integer(1)),'state':enum('active','retracted'),'occurred_at':TIME,'raw_text':TEXT,'entry':ref('StoredEntry')},['entry_id','version','supersedes_version','state','occurred_at','raw_text','entry']),100),'entries_complete':BOOL,'entry_cursor':nullable(string(2048))},['session','entries','entries_complete','entry_cursor'])
defs['RawRecord']=obj({'record_ref':ID,'version_ref':ID,'dataset':ID,'profile_ref':ID,'raw_hash':string(64),'byte_length':integer(),'raw_json':nullable({'type':'string','maxLength':200000}),'complete':BOOL,'chunk_ref':nullable(ID),'is_deleted':nullable(BOOL),'quality_flags':arr(ID)},['record_ref','version_ref','dataset','profile_ref','raw_hash','byte_length','raw_json','complete','chunk_ref','is_deleted','quality_flags'])
defs['Measurement']=obj({'weight':ref('RawRecord'),'ext_data_raw':nullable({'type':'string','maxLength':200000}),'ext_data_parsed':{},'ext_parse_status':enum('missing','null','empty','ok','invalid','blocked'),'relations':arr(obj({'dataset':ID,'status':enum('exact','missing','ambiguous','unverified','not_applicable'),'records':arr(ref('RawRecord'),50),'next_cursor':nullable(string(2048))},['dataset','status','records','next_cursor']),8),'complete':BOOL},['weight','ext_data_raw','ext_data_parsed','ext_parse_status','relations','complete'])
defs['Summary']=obj({'record_ref':ID,'profile_ref':ID,'measured_at':nullable(TIME),'local_date':nullable({'type':'string','format':'date'}),'metrics':{'type':'object','additionalProperties':nullable({'type':'number'})},'quality_flags':arr(ID)},['record_ref','profile_ref','measured_at','local_date','metrics','quality_flags'])
defs['Trend']=obj({'start':TIME,'end':TIME,'interval':enum('day','week','month'),'timezone':string(80),'formula_version':ID,'points':arr(obj({'period_start':TIME,'period_end':TIME,'group_key':ID,'metric':ID,'value':nullable({'type':'number'}),'unit':string(40),'samples':integer(),'valid_days':integer(),'missing_count':integer(),'quality_flags':arr(ID)},['period_start','period_end','group_key','metric','value','unit','samples','valid_days','missing_count','quality_flags']),1000)},['start','end','interval','timezone','formula_version','points'])
defs['SyncStatus']=obj({'last_success_at':nullable(TIME),'last_attempt_at':nullable(TIME),'batch_id':nullable(ID),'state':enum('empty','staging','published','partial','failed'),'coverage':enum('unknown','partial','verified_window'),'counts':{'type':'object','additionalProperties':integer()},'error_code':nullable(ID)},['last_success_at','last_attempt_at','batch_id','state','coverage','counts','error_code'])
defs['Error']=obj({'code':ID,'message':TEXT,'retryable':BOOL,'persistence':enum('not_applicable','not_committed','unknown'),'retry_after_seconds':integer(),'current_revision':integer()},['code','message','retryable','persistence'])
def output(data,write=False):
    return obj({'schema_version':{'const':'1'},'request_id':ID,'status':enum('ok','empty','error'),
        'data':nullable(data),'error':nullable(ref('Error')),'stale':BOOL,'synced_at':nullable(TIME),'next_cursor':nullable(string(2048)),
        'persistence':enum('committed','not_committed','unknown') if write else {'const':'not_applicable'}},['schema_version','request_id','status','data','error','stale','synced_at','next_cursor','persistence'])
range_props={'start':TIME,'end':TIME,'timezone':string(80),'limit':{'type':'integer','minimum':1,'maximum':200},'cursor':string(2048)}
body_props={**range_props,'profile_ref':ID,'include_deleted':BOOL}
idem={'idempotency_key':{'type':'string','minLength':16,'maxLength':128},'expected_revision':integer()}
tools=[]
def tool(name,scope,inputs,required,data,write=False,destructive=False,idempotent=True):
    tools.append({'name':name,'inputSchema':obj(inputs,required),'outputSchema':output(data,write),'securitySchemes':[{'type':'oauth2','scopes':scope}],
        '_meta':{'securitySchemes':[{'type':'oauth2','scopes':scope}]},'annotations':{'readOnlyHint':not write,'destructiveHint':destructive,'openWorldHint':False,'idempotentHint':idempotent}})
tool('get_latest_measurement_full',['body:read'],{'profile_ref':ID,'include_deleted':BOOL},[],ref('Measurement'))
tool('get_measurements',['body:read'],{**body_props,'detail':enum('summary','full')},['start','end'],arr({'anyOf':[ref('Measurement'),ref('Summary')]}))
tool('get_raw_dataset',['body:read'],{**body_props,'dataset':enum('weight','impedance','hr','balance','gravity','height','rulers','skip'),'measurement_ref':ID},['dataset','start','end'],arr(ref('RawRecord')))
tool('get_raw_record_chunk',['body:read'],{'version_ref':ID,'chunk_index':integer()},['version_ref','chunk_index'],obj({'data_base64':string(40000),'chunk_index':integer(),'chunk_count':integer(1),'record_sha256':string(64),'chunk_sha256':string(64)},['data_base64','chunk_index','chunk_count','record_sha256','chunk_sha256']))
tool('get_sync_status',['body:read'],{},[],ref('SyncStatus'))
for name,fields in [('list_profiles',{'profile_ref':ID,'label':string(80)}),('list_devices',{'device_ref':ID,'model':nullable(string(120)),'firmware':nullable(string(120))})]:
    tool(name,['body:read'],{'limit':range_props['limit'],'cursor':range_props['cursor']},[],arr(obj(fields,fields.keys())))
trend_inputs={**range_props,'interval':enum('day','week','month')}
tool('get_trend',['body:read'],{**trend_inputs,'profile_ref':ID,'metrics':arr(enum('weight_kg','body_fat_pct','fat_mass_kg','fat_free_mass_kg'),4,1),'daily_reducer':{'const':'median'}},['start','end'],ref('Trend'))
tool('get_open_workout_sessions',['workout:read'],{'limit':range_props['limit'],'cursor':range_props['cursor']},[],arr(ref('Session')))
tool('get_workout_history',['workout:read'],{**range_props,'session_id':ID,'entry_cursor':string(2048),'exercise_id':ID,'equipment_ref':ID,'status':enum('open','finalized'),'include_superseded':BOOL},['start','end'],arr(ref('Workout')))
tool('get_training_trend',['workout:read'],{**trend_inputs,'exercise_id':ID,'equipment_ref':ID},['start','end'],ref('Trend'))
tool('get_progress_overview',['body:read','workout:read'],{**trend_inputs,'profile_ref':ID},['start','end'],obj({'body':ref('Trend'),'training':ref('Trend')},['body','training']))
tool('get_write_receipt',['workout:read'],{'idempotency_key':ID},['idempotency_key'],ref('Receipt'))
tool('start_workout_session',['workout:write'],{**idem,'started_at':TIME,'timezone':string(80),'facility':string(120),'raw_text':TEXT},['idempotency_key','expected_revision','started_at','timezone','raw_text'],ref('Receipt'),True)
tool('record_workout_event',['workout:write'],{**idem,'session_id':ID,'occurred_at':TIME,'timezone':string(80),'raw_text':TEXT,'completion':{'const':'completed'},'entries':arr(ref('Entry'),20,1)},['idempotency_key','expected_revision','occurred_at','timezone','raw_text','completion','entries'],ref('Receipt'),True)
tool('finalize_workout_session',['workout:write'],{**idem,'session_id':ID,'ended_at':TIME,'raw_text':TEXT,'duration_seconds':integer(),'overall_rpe':{'type':'number','minimum':0,'maximum':10},'calories_kcal':KCAL,'notes':TEXT},['idempotency_key','expected_revision','session_id','ended_at','raw_text'],ref('Receipt'),True,True)
tool('reopen_workout_session',['workout:write'],{**idem,'session_id':ID,'raw_text':TEXT},['idempotency_key','expected_revision','session_id','raw_text'],ref('Receipt'),True,True)
tool('amend_workout_entry',['workout:write'],{**idem,'session_id':ID,'entry_id':ID,'raw_text':TEXT,'replacement':ref('Entry'),'state':enum('active','retracted')},['idempotency_key','expected_revision','session_id','entry_id','raw_text','replacement','state'],ref('Receipt'),True,True)
contract={'$schema':'https://json-schema.org/draft/2020-12/schema','$defs':defs,'contract_version':'1','tools':tools}
(ROOT/'mcp-schemas.json').write_text(json.dumps(contract,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print('generated',len(tools),'tools')
