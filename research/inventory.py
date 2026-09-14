"""记录已审查上游和已安装依赖的版本/许可证/文件hash，不读取秘密。"""
import hashlib
import json
import subprocess
from pathlib import Path
root=Path(__file__).resolve().parent
vendor=root.parents[2]/'vendor'
out={'checked_at':'2026-09-14','upstream':[]}
for name in ['fitdays-api','fitdays-mcp-server']:
    path=vendor/name
    pkg=json.loads((path/'package.json').read_text(encoding='utf-8'))
    lock=json.loads((path/'package-lock.json').read_text(encoding='utf-8'))
    out['upstream'].append({'repository':'https://github.com/roquerodrigo/'+name,'commit':subprocess.check_output(['git','-C',str(path),'rev-parse','HEAD'],text=True).strip(),'version':pkg['version'],'license':pkg['license'],'dependencies':pkg.get('dependencies',{}),'devDependencies':pkg.get('devDependencies',{}),'lockfile_version':lock['lockfileVersion'],'package_count':len(lock['packages']),'lock_sha256':hashlib.sha256((path/'package-lock.json').read_bytes()).hexdigest(),'license_sha256':hashlib.sha256((path/'LICENSE').read_bytes()).hexdigest()})
lock=json.loads((root/'spike/package-lock.json').read_text(encoding='utf-8'))
out['spike_lock_sha256']=hashlib.sha256((root/'spike/package-lock.json').read_bytes()).hexdigest()
out['spike_packages']=[{'path':name,'version':p.get('version'),'license':p.get('license','UNVERIFIED'),'dev':p.get('dev',False)} for name,p in lock['packages'].items() if name]
(root/'upstream-inventory.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print('upstream and',len(out['spike_packages']),'locked packages inventoried')
