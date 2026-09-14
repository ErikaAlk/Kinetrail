"""在内存副本移除计划拦截，确认回归检查会失败，不改共享文件。"""
from pathlib import Path
path=Path(__file__).with_name('core-check.py')
source=path.read_text(encoding='utf-8')
original="if kind == 'record' and completion != 'completed':"
assert source.count(original)==1
mutant=source.replace(original,'if False:')
try:
    exec(compile(mutant,str(path),'exec'),{'__file__':str(path),'__name__':'__main__'})
except AssertionError as error:
    assert '必须拒绝 NEEDS_CLARIFICATION' in str(error),str(error)
    print('PASS regression mutation: removal of plan guard fails at intended assertion')
else:
    raise AssertionError('测试未能检测计划拦截缺失')
